// The least of protobuf needed to read a message whose schema is not known: its fields by number, each a number
// (varint), or bytes (a string, or a nested message to be read the same way). Fixed-width fields are skipped over.

export interface ProtoField {
  field: number;
  /** A varint's value, for a field that is one. */
  number?: number;
  /** A length-delimited field's bytes. */
  bytes?: Buffer;
}

/** The fields of one message, in order. Throws on bytes that are not a protobuf message. */
export function protoFields(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= buf.length) throw new Error("protobuf: cut short");
      const byte = buf[at++]!;
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 128;
    }
    throw new Error("protobuf: varint too long");
  };
  while (at < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) throw new Error("protobuf: field 0");
    if (wire === 0) out.push({ field, number: varint() });
    else if (wire === 2) {
      const length = varint();
      if (at + length > buf.length) throw new Error("protobuf: cut short");
      out.push({ field, bytes: buf.subarray(at, at + length) });
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error(`protobuf: wire type ${wire}`);
    if (at > buf.length) throw new Error("protobuf: cut short");
  }
  return out;
}

/** The first field with this number: its bytes, or undefined. */
export const protoBytes = (fields: ProtoField[], field: number): Buffer | undefined => fields.find((f) => f.field === field)?.bytes;
export const protoText = (fields: ProtoField[], field: number): string => protoBytes(fields, field)?.toString("utf8") ?? "";
export const protoNumber = (fields: ProtoField[], field: number): number => fields.find((f) => f.field === field)?.number ?? 0;
/** A nested message; no fields when it is absent or not a message. */
export function protoMessage(fields: ProtoField[], field: number): ProtoField[] {
  const bytes = protoBytes(fields, field);
  if (!bytes) return [];
  try {
    return protoFields(bytes);
  } catch {
    return [];
  }
}
