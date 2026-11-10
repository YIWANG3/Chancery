// axctl: drives Claude Desktop through the macOS Accessibility API, in the background, without
// activating it. Built by scripts/build-native.sh into native/bin/axctl. The executor calls it;
// every result is one JSON object on stdout.
//
//   axctl trusted [--prompt]          {"trusted":bool}
//   axctl probe                        projects the sidebar offers, composer state, usage
//   axctl usage                        {"usage":"Weekly · Fable: 45%, …","pct":45}
//   axctl new-session --project NAME --prompt-file PATH [--worktree | --no-worktree] [--wait SECONDS]
//   axctl reply --session local_ID --prompt-file PATH [--wait SECONDS] [--stay]
//   axctl codex-reply --thread ID --title TITLE --prompt-file PATH [--wait SECONDS]
//   axctl dump --app claude|codex [--grep TEXT]
//
// The two reply commands send a message into an existing conversation. Each first takes the app to that
// conversation with the app's own link, then checks that the app is really showing it, and only then writes and
// sends. A message typed into whatever conversation happened to be open would be worse than no message, so every
// doubt ends in a failure with nothing sent.
//
// Selectors are plain data (ROLE + title/description) so a future resolver can replace them when
// Claude Desktop's tree changes; `probe` dumps what the tree currently exposes.
import AppKit
import ApplicationServices
import Foundation

let bundleId = "com.anthropic.claudefordesktop"

struct Node {
  let el: AXUIElement
  let role: String
  let title: String
  let desc: String
  let value: String
  let depth: Int
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func text(_ el: AXUIElement, _ name: String) -> String {
  guard let v = attr(el, name) else { return "" }
  if let s = v as? String { return s }
  if let a = v as? NSAttributedString { return a.string }
  if let n = v as? NSNumber { return n.stringValue }
  return "\(v)"
}

func children(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, "AXChildren") as? [AXUIElement]) ?? []
}

func walk(_ el: AXUIElement, _ depth: Int, _ out: inout [Node], _ budget: inout Int) {
  if depth > 60 || budget <= 0 { return }
  budget -= 1
  let role = text(el, "AXRole")
  out.append(Node(el: el, role: role, title: text(el, "AXTitle"), desc: text(el, "AXDescription"), value: text(el, "AXValue"), depth: depth))
  for c in children(el) { walk(c, depth + 1, &out, &budget) }
}

func fail(_ code: Int32, _ message: String) -> Never {
  print("{\"ok\":false,\"error\":\(jsonString(message))}")
  exit(code)
}

func jsonString(_ s: String) -> String {
  let data = try! JSONSerialization.data(withJSONObject: [s])
  let arr = String(data: data, encoding: .utf8)!
  return String(arr.dropFirst().dropLast())
}

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

let codexBundleId = "com.openai.codex"

func appElement(_ bundle: String, _ label: String) -> AXUIElement {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else {
    fail(3, "\(label) is not running")
  }
  let el = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  return el
}

/// The Codex app (ChatGPT.app) reports no AXWindows; its content hangs off AXMainWindow.
func codexSnapshot(_ app: AXUIElement) -> [Node] {
  var out: [Node] = []
  var budget = 60000
  let main = attr(app, "AXMainWindow").map { $0 as! AXUIElement }
  if let main = main { walk(main, 0, &out, &budget) }
  // When the app does list its windows, the main one is among them: walk it once.
  for w in (attr(app, "AXWindows") as? [AXUIElement]) ?? [] where main == nil || !CFEqual(w, main!) { walk(w, 0, &out, &budget) }
  return out
}

func claudeApp() -> AXUIElement {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    fail(3, "Claude Desktop is not running")
  }
  let el = AXUIElementCreateApplication(app.processIdentifier)
  // Electron exposes a bare tree until an assistive client asks for the full one.
  AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  return el
}

func snapshot(_ app: AXUIElement) -> [Node] {
  var out: [Node] = []
  var budget = 30000
  for w in (attr(app, "AXWindows") as? [AXUIElement]) ?? [] { walk(w, 0, &out, &budget) }
  return out
}

func find(_ nodes: [Node], role: String, title: String? = nil, desc: String? = nil, descPrefix: String? = nil) -> Node? {
  nodes.first { n in
    n.role == role
      && (title == nil || n.title.trimmingCharacters(in: .whitespaces) == title!)
      && (desc == nil || n.desc == desc!)
      && (descPrefix == nil || n.desc.hasPrefix(descPrefix!))
  }
}

/// Re-reads the tree until the predicate finds something or the timeout passes.
func waitFor(_ app: AXUIElement, seconds: Double, _ pick: ([Node]) -> Node?) -> Node? {
  let deadline = Date().addingTimeInterval(seconds)
  repeat {
    if let n = pick(claudeNodes(app)) { return n }
    Thread.sleep(forTimeInterval: 0.5)
  } while Date() < deadline
  return nil
}

func press(_ n: Node) -> Bool { AXUIElementPerformAction(n.el, "AXPress" as CFString) == .success }

func composerState(_ nodes: [Node]) -> [String: Any] {
  var s: [String: Any] = ["present": find(nodes, role: "AXTextArea", desc: "Prompt") != nil]
  if let e = find(nodes, role: "AXPopUpButton", descPrefix: "Environment: ") { s["environment"] = String(e.desc.dropFirst("Environment: ".count)) }
  if let w = find(nodes, role: "AXCheckBox", title: "Worktree") { s["worktree"] = w.value == "1" }
  if let m = find(nodes, role: "AXPopUpButton", descPrefix: "Model: ") { s["model"] = String(m.desc.dropFirst("Model: ".count)) }
  if let p = find(nodes, role: "AXPopUpButton", descPrefix: "Permissions: ") { s["permissions"] = String(p.desc.dropFirst("Permissions: ".count)) }
  if let u = find(nodes, role: "AXPopUpButton", descPrefix: "Usage: ") { s["usage"] = String(u.desc.dropFirst("Usage: ".count)) }
  return s
}

func usagePct(_ usage: String) -> Int? {
  let re = try! NSRegularExpression(pattern: "(\\d+)%")
  guard let m = re.firstMatch(in: usage, range: NSRange(usage.startIndex..., in: usage)), let r = Range(m.range(at: 1), in: usage) else { return nil }
  return Int(usage[r])
}

/// Opens a link without bringing its app to the front.
func openInBackground(_ url: String) -> Bool {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  p.arguments = ["-g", url]
  do {
    try p.run()
    p.waitUntilExit()
    return p.terminationStatus == 0
  } catch {
    return false
  }
}

/// Claude Desktop's tree, also right after launch or a first query, when AXWindows can still be empty.
func claudeNodes(_ app: AXUIElement) -> [Node] {
  var out = snapshot(app)
  if out.isEmpty, let main = attr(app, "AXMainWindow") {
    var budget = 30000
    walk(main as! AXUIElement, 0, &out, &budget)
  }
  return out
}

/// The desktop session ids Claude Desktop is showing. The page address of a Code session ends in its id
/// (`https://claude.ai/epitaxy/local_…`), so this is exact, not a guess from a title.
func claudeShownSessions(_ nodes: [Node]) -> [String] {
  var ids: [String] = []
  for n in nodes where n.role == "AXWebArea" {
    let url = text(n.el, "AXURL")
    guard let r = url.range(of: "/epitaxy/") else { continue }
    let id = String(url[r.upperBound...].prefix { $0 != "/" && $0 != "?" && $0 != "#" })
    if id.hasPrefix("local_") && !ids.contains(id) { ids.append(id) }
  }
  return ids
}

/// What the composer holds, with the lone newline an empty one reports removed.
func draft(_ box: Node) -> String { box.value.trimmingCharacters(in: .whitespacesAndNewlines) }

let codexComposer = "Work with ChatGPT"

/// After a send the Codex composer can show the sent text again: a write it had not committed yet lands on the
/// next interaction. Left there it reads as a draft, and one Return would send the message twice. This empties the
/// composer for as long as it keeps holding text that starts with `head`, and says whether it ended up empty.
func codexClearComposer(_ app: AXUIElement, head: String) -> Bool {
  var quiet = 0
  for _ in 0..<12 {
    Thread.sleep(forTimeInterval: 0.5)
    guard let box = find(codexSnapshot(app), role: "AXTextArea", title: codexComposer) else { return true }
    if box.value.contains(head) {
      quiet = 0
      AXUIElementSetAttributeValue(box.el, "AXValue" as CFString, "" as CFString)
      Thread.sleep(forTimeInterval: 0.4)
      if let again = find(codexSnapshot(app), role: "AXTextArea", title: codexComposer) { _ = press(again) }
    } else {
      quiet += 1
      if quiet >= 3 { return true }
    }
  }
  return false
}

func arg(_ name: String) -> String? {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
  return a[i + 1]
}
let flags = Set(CommandLine.arguments)
let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "help"

switch command {
case "trusted":
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: flags.contains("--prompt")] as CFDictionary
  emit(["ok": true, "trusted": AXIsProcessTrustedWithOptions(opts)])

case "probe", "usage":
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  let app = claudeApp()
  Thread.sleep(forTimeInterval: 2.0)
  // A query can find a bare shell of a tree (nothing at all, or a window and a few empty groups) or one that is
  // still filling in; that has been seen to last twenty seconds. So `probe` reads until the sidebar's projects are
  // there (with the sidebar collapsed they never are, and the answer is an empty list after the whole wait), and
  // `usage` until there is a tree to speak of.
  let newSessionIn = "New session in "
  func offered(_ nodes: [Node]) -> [String] { nodes.filter { $0.role == "AXButton" && $0.desc.hasPrefix(newSessionIn) }.map { String($0.desc.dropFirst(newSessionIn.count)) } }
  var nodes = claudeNodes(app)
  let filled = Date().addingTimeInterval(15)
  while (command == "probe" ? offered(nodes).isEmpty : nodes.count < 50) && Date() < filled {
    Thread.sleep(forTimeInterval: 0.5)
    nodes = claudeNodes(app)
  }
  let composer = composerState(nodes)
  if command == "usage" {
    let u = composer["usage"] as? String ?? ""
    emit(["ok": !u.isEmpty, "usage": u, "pct": usagePct(u) as Any])
  } else {
    emit(["ok": true, "nodes": nodes.count, "projects": offered(nodes), "composer": composer])
  }

case "new-session":
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  guard let project = arg("--project"), let promptFile = arg("--prompt-file") else { fail(1, "usage: new-session --project NAME --prompt-file PATH [--worktree | --no-worktree] [--wait SECONDS]") }
  guard let prompt = try? String(contentsOfFile: promptFile, encoding: .utf8), !prompt.isEmpty else { fail(1, "prompt file unreadable or empty") }
  let wait = Double(arg("--wait") ?? "8") ?? 8
  let app = claudeApp()
  Thread.sleep(forTimeInterval: 2.0)

  // The sidebar may not be in the tree yet (see probe), so the button is looked for over a few seconds.
  guard let newButton = waitFor(app, seconds: wait, { find($0, role: "AXButton", desc: "New session in \(project)") }) else {
    fail(4, "no 'New session in \(project)' button in the sidebar; Claude Desktop only lists projects it has opened before")
  }
  if !press(newButton) { fail(4, "AXPress on the new-session button failed") }

  // The conversation that was showing has a composer too, and for a moment after the press it is still the one in
  // the tree. Only the composer of a new session carries the "Environment: …" control, so that is what is waited
  // for: a prompt written into whatever conversation was open would be worse than no session.
  guard let promptBox = waitFor(app, seconds: wait, { nodes in
    find(nodes, role: "AXPopUpButton", descPrefix: "Environment: ") == nil ? nil : find(nodes, role: "AXTextArea", desc: "Prompt")
  }) else { fail(4, "the new-session composer did not appear") }

  // The checkbox keeps whatever the last session used, so either flag sets it and neither leaves it alone. A folder
  // that is not a git repository has no checkbox: nothing to turn off there, and nothing that could be turned on.
  var worktree = false
  if flags.contains("--worktree") || flags.contains("--no-worktree") {
    let want = flags.contains("--worktree")
    if let box = find(claudeNodes(app), role: "AXCheckBox", title: "Worktree") {
      if (box.value == "1") != want {
        _ = press(box)
        Thread.sleep(forTimeInterval: 0.6)
      }
      guard let after = find(claudeNodes(app), role: "AXCheckBox", title: "Worktree"), (after.value == "1") == want else { fail(4, "Worktree checkbox did not turn \(want ? "on" : "off")") }
    } else if want {
      fail(4, "no Worktree checkbox in the composer")
    }
    worktree = want
  }

  if AXUIElementSetAttributeValue(promptBox.el, "AXValue" as CFString, prompt as CFString) != .success { fail(4, "could not write the prompt") }
  Thread.sleep(forTimeInterval: 0.6)
  let written = text(promptBox.el, "AXValue")
  if !written.hasPrefix(String(prompt.prefix(40))) { fail(4, "prompt did not land in the composer") }

  // A posted Return key does nothing here; the Send button does.
  guard let send = find(snapshot(app), role: "AXButton", desc: "Send") else { fail(4, "no Send button") }
  if !press(send) { fail(4, "AXPress on Send failed") }
  let state = composerState(snapshot(app))
  emit(["ok": true, "project": project, "worktree": worktree, "environment": state["environment"] as Any, "sentAt": ISO8601DateFormatter().string(from: Date())])

case "reply":
  // Claude Desktop: link to the session → the page address must end in that session's id → composer → Send.
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  guard let session = arg("--session"), let promptFile = arg("--prompt-file") else { fail(1, "usage: reply --session local_ID --prompt-file PATH [--wait SECONDS] [--stay]") }
  if session.range(of: "^local_[A-Za-z0-9-]{1,64}$", options: .regularExpression) == nil { fail(1, "not a desktop session id") }
  guard let prompt = try? String(contentsOfFile: promptFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty else { fail(1, "prompt file unreadable or empty") }
  let wait = Double(arg("--wait") ?? "10") ?? 10
  let app = claudeApp()
  var nodes: [Node] = []
  let ready = Date().addingTimeInterval(6)
  repeat {
    Thread.sleep(forTimeInterval: 0.5)
    nodes = claudeNodes(app)
  } while nodes.isEmpty && Date() < ready
  if nodes.isEmpty { fail(4, "Claude Desktop has no window to work in") }

  let before = claudeShownSessions(nodes)
  if before != [session] {
    if !openInBackground("claude://code/continue?session=\(session)") { fail(4, "could not open the link to the session") }
    let deadline = Date().addingTimeInterval(wait)
    repeat {
      Thread.sleep(forTimeInterval: 0.5)
      nodes = claudeNodes(app)
    } while claudeShownSessions(nodes) != [session] && Date() < deadline
  }
  let shown = claudeShownSessions(nodes)
  if shown != [session] { fail(5, "Claude Desktop did not switch to the session (showing: \(shown.isEmpty ? "no session" : shown.joined(separator: ", "))); nothing was sent") }

  /// Puts Claude Desktop back on the session it was showing, when it was showing exactly one other.
  func goBack() -> Bool {
    if flags.contains("--stay") || before.count != 1 || before[0] == session { return false }
    return openInBackground("claude://code/continue?session=\(before[0])")
  }
  func giveUp(_ message: String) -> Never {
    _ = goBack()
    fail(5, message + "; nothing was sent")
  }

  // The composer belongs to the session only once its page has finished loading; a split view has several.
  var boxes: [Node] = []
  let composerBy = Date().addingTimeInterval(wait)
  repeat {
    boxes = nodes.filter { $0.role == "AXTextArea" && $0.desc == "Prompt" }
    if boxes.count == 1 { break }
    Thread.sleep(forTimeInterval: 0.5)
    nodes = claudeNodes(app)
  } while Date() < composerBy
  if boxes.count != 1 { giveUp(boxes.isEmpty ? "the session has no composer" : "several composers are open (split view)") }
  let box = boxes[0]
  if !draft(box).isEmpty { giveUp("the composer already holds a draft") }
  // While a turn is running the button is Stop, and Return would queue the message instead of sending it.
  if find(nodes, role: "AXButton", desc: "Stop") != nil { giveUp("the session is still running") }

  if AXUIElementSetAttributeValue(box.el, "AXValue" as CFString, prompt as CFString) != .success { giveUp("could not write into the composer") }
  Thread.sleep(forTimeInterval: 0.6)
  nodes = claudeNodes(app)
  func clearAndGiveUp(_ message: String) -> Never {
    if let b = find(nodes, role: "AXTextArea", desc: "Prompt") { AXUIElementSetAttributeValue(b.el, "AXValue" as CFString, "" as CFString) }
    giveUp(message)
  }
  guard let written = find(nodes, role: "AXTextArea", desc: "Prompt"), draft(written).hasPrefix(String(prompt.prefix(40))) else { clearAndGiveUp("the text did not land in the composer") }
  // The check that matters, made again at the last moment: still this session, and nothing else.
  if claudeShownSessions(nodes) != [session] { clearAndGiveUp("Claude Desktop moved to another session while writing") }
  guard let send = find(nodes, role: "AXButton", desc: "Send") else { clearAndGiveUp("no Send button") }
  if !press(send) { clearAndGiveUp("pressing Send failed") }

  var sent = false
  let sentBy = Date().addingTimeInterval(5)
  repeat {
    Thread.sleep(forTimeInterval: 0.4)
    if let b = find(claudeNodes(app), role: "AXTextArea", desc: "Prompt"), draft(b).isEmpty { sent = true }
  } while !sent && Date() < sentBy
  if !sent { fail(6, "Send was pressed but the composer still holds the text; check the session in Claude Desktop") }
  emit(["ok": true, "session": session, "wentBack": goBack(), "sentAt": ISO8601DateFormatter().string(from: Date())])

case "codex-reply":
  // Codex app: link to the thread → the window's title must be the thread's → composer → Send. The page address
  // says nothing about the thread, so the title is the only thing to check here; the caller confirms afterwards
  // from Codex's own database that this thread, and not another one of the same name, started a turn.
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  guard let thread = arg("--thread"), let title = arg("--title"), let promptFile = arg("--prompt-file") else { fail(1, "usage: codex-reply --thread ID --title TITLE --prompt-file PATH [--wait SECONDS]") }
  if thread.range(of: "^[0-9a-fA-F-]{36}$", options: .regularExpression) == nil { fail(1, "not a thread id") }
  guard let prompt = try? String(contentsOfFile: promptFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty else { fail(1, "prompt file unreadable or empty") }
  let want = title.trimmingCharacters(in: .whitespacesAndNewlines)
  if want.isEmpty { fail(1, "a thread with no title cannot be told apart from the others") }
  let wait = Double(arg("--wait") ?? "10") ?? 10
  let app = appElement(codexBundleId, "Codex app")
  Thread.sleep(forTimeInterval: 1.0)
  /// The title of the window showing a conversation. Other windows (settings, pop-outs) have their own.
  func shownTitle(_ nodes: [Node]) -> String {
    (nodes.first { $0.role == "AXWindow" }?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }
  if !openInBackground("codex://threads/\(thread)") { fail(4, "could not open the link to the thread") }
  var nodes: [Node] = []
  let deadline = Date().addingTimeInterval(wait)
  repeat {
    Thread.sleep(forTimeInterval: 0.5)
    nodes = codexSnapshot(app)
  } while shownTitle(nodes) != want && Date() < deadline
  if shownTitle(nodes) != want { fail(5, "the Codex app did not switch to the thread (showing: \(shownTitle(nodes))); nothing was sent") }
  // Let the thread's own page settle: the title changes before the old composer is replaced.
  Thread.sleep(forTimeInterval: 1.0)
  nodes = codexSnapshot(app)
  let composerTitle = codexComposer
  let boxes = nodes.filter { $0.role == "AXTextArea" && $0.title == composerTitle }
  if boxes.count != 1 { fail(5, (boxes.isEmpty ? "the thread has no composer" : "several composers are open") + "; nothing was sent") }
  // An empty composer reads back its own placeholder.
  if draft(boxes[0]) != composerTitle && !draft(boxes[0]).isEmpty { fail(5, "the composer already holds a draft; nothing was sent") }
  if find(nodes, role: "AXButton", title: "Stop") != nil { fail(5, "the thread is still running; nothing was sent") }

  // Same quirk as a new chat: an AX write is committed only on the next interaction with the box, and the first
  // write can be swallowed. Write, press, read back; repeat until it reads what was written.
  let head = String(prompt.prefix(12))
  var landed = false
  var lastRead = ""
  for _ in 0..<4 {
    guard let box = find(codexSnapshot(app), role: "AXTextArea", title: composerTitle) else { fail(5, "composer vanished while writing; nothing was sent") }
    if AXUIElementSetAttributeValue(box.el, "AXValue" as CFString, prompt as CFString) != .success { fail(5, "could not write into the composer; nothing was sent") }
    Thread.sleep(forTimeInterval: 0.5)
    if let again = find(codexSnapshot(app), role: "AXTextArea", title: composerTitle) { _ = press(again) }
    for _ in 0..<3 {
      Thread.sleep(forTimeInterval: 0.5)
      if let fresh = find(codexSnapshot(app), role: "AXTextArea", title: composerTitle) {
        lastRead = fresh.value
        if fresh.value.contains(head) { landed = true; break }
      }
    }
    if landed { break }
  }
  if !landed { fail(5, "the text did not land in the composer (box reads: \(String(lastRead.prefix(60)))); nothing was sent") }
  nodes = codexSnapshot(app)
  if shownTitle(nodes) != want { fail(5, "the Codex app moved to another thread while writing; the text is left in its composer, nothing was sent") }
  guard let send = find(nodes, role: "AXButton", title: "Send") else { fail(5, "no Send button; the text is left in the composer, nothing was sent") }
  if !press(send) { fail(5, "pressing Send failed; the text is left in the composer") }
  let sentAt = Date()
  let clean = codexClearComposer(app, head: head)
  emit(["ok": true, "thread": thread, "composerEmpty": clean, "sentAt": ISO8601DateFormatter().string(from: sentAt), "sentAtEpoch": Int(sentAt.timeIntervalSince1970)])

case "codex-clear":
  // Recovery: empties the Codex composer if it holds text starting with the given file's text. For a send that
  // left its text behind.
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  guard let file = arg("--text-file"), let t = try? String(contentsOfFile: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { fail(1, "usage: codex-clear --text-file PATH") }
  let app = appElement(codexBundleId, "Codex app")
  Thread.sleep(forTimeInterval: 1.0)
  emit(["ok": true, "composerEmpty": codexClearComposer(app, head: String(t.prefix(12)))])

case "codex-probe":
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  let app = appElement(codexBundleId, "Codex app")
  Thread.sleep(forTimeInterval: 1.5)
  let nodes = codexSnapshot(app)
  let projects = nodes.filter { $0.role == "AXButton" && $0.title.hasPrefix("Start new chat in ") }.map { String($0.title.dropFirst("Start new chat in ".count)) }
  let composer = find(nodes, role: "AXTextArea", title: "Work with ChatGPT") != nil
  let project = nodes.first { $0.role == "AXPopUpButton" && $0.desc.hasPrefix("Change project: ") }.map { String($0.desc.dropFirst("Change project: ".count)) }
  let model = nodes.first { $0.role == "AXPopUpButton" && $0.title.hasPrefix("GPT") }?.title
  emit(["ok": true, "nodes": nodes.count, "projects": projects, "composer": ["present": composer, "project": project as Any, "model": model as Any]])

case "codex-new-chat":
  // Codex app: sidebar "Start new chat in <folder>" → composer (AXTextArea "Work with ChatGPT") → Send.
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  guard let project = arg("--project"), let promptFile = arg("--prompt-file") else { fail(1, "usage: codex-new-chat --project NAME --prompt-file PATH [--wait SECONDS]") }
  guard let prompt = try? String(contentsOfFile: promptFile, encoding: .utf8), !prompt.isEmpty else { fail(1, "prompt file unreadable or empty") }
  let wait = Double(arg("--wait") ?? "8") ?? 8
  let app = appElement(codexBundleId, "Codex app")
  Thread.sleep(forTimeInterval: 1.5)
  // Right after a send the app ignores the sidebar for a moment: press "Start new chat", look for the fresh
  // composer (it carries a "Change project: <folder>" control that a chat view does not), retry a few times.
  var box: Node? = nil
  for attempt in 0..<4 {
    guard let start = find(codexSnapshot(app), role: "AXButton", title: "Start new chat in \(project)") else {
      fail(4, "no 'Start new chat in \(project)' in the Codex sidebar; add the folder as a project in the Codex app first")
    }
    if !press(start) { fail(4, "AXPress on the start button failed") }
    let deadline = Date().addingTimeInterval(attempt == 0 ? wait : 3.0)
    repeat {
      Thread.sleep(forTimeInterval: 0.5)
      let nodes = codexSnapshot(app)
      if nodes.contains(where: { $0.role == "AXPopUpButton" && $0.desc == "Change project: \(project)" }) {
        box = find(nodes, role: "AXTextArea", title: "Work with ChatGPT")
      }
    } while box == nil && Date() < deadline
    if box != nil { break }
    Thread.sleep(forTimeInterval: 2.0)
  }
  guard let promptBox = box else { fail(4, "composer for \(project) did not appear") }
  // The Codex composer commits an AX write only on the next interaction with the box, and the first write after a
  // fresh composer is swallowed: write, press, read; repeat until the box reads back what we wrote.
  let head = String(prompt.prefix(12))
  var landed = false
  var lastRead = ""
  for _ in 0..<4 {
    guard let box = find(codexSnapshot(app), role: "AXTextArea", title: "Work with ChatGPT") else { fail(4, "composer vanished while writing the prompt") }
    if AXUIElementSetAttributeValue(box.el, "AXValue" as CFString, prompt as CFString) != .success { fail(4, "could not write the prompt") }
    Thread.sleep(forTimeInterval: 0.5)
    if let again = find(codexSnapshot(app), role: "AXTextArea", title: "Work with ChatGPT") { _ = press(again) }
    for _ in 0..<3 {
      Thread.sleep(forTimeInterval: 0.5)
      if let fresh = find(codexSnapshot(app), role: "AXTextArea", title: "Work with ChatGPT") {
        lastRead = fresh.value
        if fresh.value.contains(head) { landed = true; break }
      }
    }
    if landed { break }
  }
  if !landed { fail(4, "prompt did not land in the composer (box reads: \(String(lastRead.prefix(60))))") }
  guard let send = find(codexSnapshot(app), role: "AXButton", title: "Send") else { fail(4, "no Send button") }
  if !press(send) { fail(4, "AXPress on Send failed") }
  emit(["ok": true, "project": project, "sentAt": ISO8601DateFormatter().string(from: Date()), "sentAtEpoch": Int(Date().timeIntervalSince1970)])

case "dump":
  // Development aid: prints the accessibility tree of one app, one node per line, for working out selectors.
  //   axctl dump --app claude|codex [--grep TEXT]
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  let which = arg("--app") ?? "claude"
  let app = which == "codex" ? appElement(codexBundleId, "Codex app") : claudeApp()
  Thread.sleep(forTimeInterval: 1.5)
  var nodes = which == "codex" ? codexSnapshot(app) : snapshot(app)
  if nodes.isEmpty, let main = attr(app, "AXMainWindow") {
    var budget = 60000
    walk(main as! AXUIElement, 0, &nodes, &budget)
  }
  let needle = arg("--grep")?.lowercased()
  let clip = { (s: String) -> String in String(s.replacingOccurrences(of: "\n", with: "⏎").prefix(90)) }
  for n in nodes {
    var extra = ""
    for name in ["AXURL", "AXSubrole", "AXSelected", "AXDOMIdentifier", "AXPlaceholderValue", "AXEnabled", "AXFocused"] {
      let v = text(n.el, name)
      if !v.isEmpty && !(name == "AXEnabled" && v == "1") && !(name == "AXFocused" && v == "0") && !(name == "AXSelected" && v == "0") { extra += " \(name.dropFirst(2))=\(clip(v))" }
    }
    let line = "\(n.depth) \(n.role) t=\(clip(n.title)) d=\(clip(n.desc)) v=\(clip(n.value))\(extra)"
    if needle == nil || line.lowercased().contains(needle!) { print(line) }
  }
  print("-- \(nodes.count) nodes")

default:
  print("axctl trusted [--prompt] | probe | usage | new-session … | reply --session ID --prompt-file PATH | codex-probe | codex-new-chat … | codex-reply --thread ID --title TITLE --prompt-file PATH | dump --app claude|codex")
  exit(1)
}
