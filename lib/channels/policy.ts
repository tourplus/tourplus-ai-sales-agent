import type { Channel } from "./types";
// Conservative application caps, measured in UTF-8 bytes. These caps also
// protect multilingual replies; they do not claim every provider's full limit.
export const textByteLimit = (channel: Channel) => channel === "instagram" ? 1000 : 2000;
export const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;
export function validChannelText(channel: Channel, text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0 && utf8Length(text) <= textByteLimit(channel) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}
export function boundedChannelText(channel: Channel, text: string) {
  let result = "";
  for (const character of text) {
    if (utf8Length(result + character) > textByteLimit(channel)) break;
    result += character;
  }
  return result;
}
