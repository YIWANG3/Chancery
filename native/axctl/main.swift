// axctl: drives Claude Desktop through the macOS Accessibility API, in the background, without
// activating it. Built by scripts/build-native.sh into native/bin/axctl. The executor calls it;
// every result is one JSON object on stdout.
//
//   axctl trusted [--prompt]          {"trusted":bool}
//   axctl probe                        projects the sidebar offers, composer state, usage
//   axctl usage                        {"usage":"Weekly · Fable: 45%, …","pct":45}
//   axctl new-session --project NAME --prompt-file PATH [--worktree] [--wait SECONDS]
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
  if let main = attr(app, "AXMainWindow") { walk(main as! AXUIElement, 0, &out, &budget) }
  for w in (attr(app, "AXWindows") as? [AXUIElement]) ?? [] { walk(w, 0, &out, &budget) }
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
    if let n = pick(snapshot(app)) { return n }
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
  let nodes = snapshot(app)
  let composer = composerState(nodes)
  if command == "usage" {
    let u = composer["usage"] as? String ?? ""
    emit(["ok": !u.isEmpty, "usage": u, "pct": usagePct(u) as Any])
  } else {
    let projects = nodes.filter { $0.role == "AXButton" && $0.desc.hasPrefix("New session in ") }.map { String($0.desc.dropFirst("New session in ".count)) }
    emit(["ok": true, "nodes": nodes.count, "projects": projects, "composer": composer])
  }

case "new-session":
  if !AXIsProcessTrusted() { fail(2, "this process is not trusted for Accessibility") }
  guard let project = arg("--project"), let promptFile = arg("--prompt-file") else { fail(1, "usage: new-session --project NAME --prompt-file PATH [--worktree] [--wait SECONDS]") }
  guard let prompt = try? String(contentsOfFile: promptFile, encoding: .utf8), !prompt.isEmpty else { fail(1, "prompt file unreadable or empty") }
  let wait = Double(arg("--wait") ?? "8") ?? 8
  let app = claudeApp()
  Thread.sleep(forTimeInterval: 2.0)

  guard let newButton = find(snapshot(app), role: "AXButton", desc: "New session in \(project)") else {
    fail(4, "no 'New session in \(project)' button in the sidebar; Claude Desktop only lists projects it has opened before")
  }
  if !press(newButton) { fail(4, "AXPress on the new-session button failed") }

  guard let promptBox = waitFor(app, seconds: wait, { find($0, role: "AXTextArea", desc: "Prompt") }) else { fail(4, "composer did not appear") }

  var worktree = false
  if flags.contains("--worktree") {
    guard let box = find(snapshot(app), role: "AXCheckBox", title: "Worktree") else { fail(4, "no Worktree checkbox in the composer") }
    if box.value != "1" {
      _ = press(box)
      Thread.sleep(forTimeInterval: 0.6)
    }
    guard let after = find(snapshot(app), role: "AXCheckBox", title: "Worktree"), after.value == "1" else { fail(4, "Worktree checkbox did not turn on") }
    worktree = true
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

default:
  print("axctl trusted [--prompt] | probe | usage | new-session … | codex-probe | codex-new-chat --project NAME --prompt-file PATH")
  exit(1)
}
