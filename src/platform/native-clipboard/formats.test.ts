import { expect, test } from "bun:test";
import { mapNativeFormats } from "./formats.js";

for (const fixture of [
  {
    platform: "darwin",
    text: "public.utf8-plain-text",
    image: "public.tiff",
    files: "public.file-url",
  },
  {
    platform: "win32",
    text: "CF_UNICODETEXT",
    image: "CF_DIBV5",
    files: "CF_HDROP",
  },
  {
    platform: "linux",
    text: "UTF8_STRING",
    image: "image/png",
    files: "text/uri-list",
  },
] as const) {
  test(`maps ${fixture.platform} metadata without file offers`, () => {
    expect(
      mapNativeFormats(fixture.platform, [
        fixture.text,
        fixture.image,
        fixture.text,
      ]),
    ).toEqual(["text/plain", "image/png"]);
    expect(
      mapNativeFormats(fixture.platform, [fixture.files, "unknown"]),
    ).toEqual([]);
    expect(mapNativeFormats(fixture.platform, [])).toEqual([]);
  });
}
test("does not infer support for another platform", () => {
  expect(mapNativeFormats("freebsd", ["UTF8_STRING", "image/png"])).toEqual([]);
});
