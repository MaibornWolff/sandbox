import { describe, expect, test } from "bun:test";
import {
  decodeBinaryChannel,
  encodeBinaryChannel,
  parseBrokerControlMessage,
  parseClientControlMessage,
  STREAM_CHANNEL,
} from "./protocol.js";

describe("host command escape protocol", () => {
  test("parses every valid client operation without changing argument boundaries", () => {
    expect(
      parseClientControlMessage(
        JSON.stringify({
          type: "execute",
          argv: ["echo", "first second", ""],
          cwd: "/project",
        }),
      ),
    ).toEqual({
      type: "execute",
      argv: ["echo", "first second", ""],
      cwd: "/project",
    });
    expect(parseClientControlMessage('{"type":"list"}')).toEqual({
      type: "list",
    });
    expect(parseClientControlMessage('{"type":"stdin-end"}')).toEqual({
      type: "stdin-end",
    });
    expect(
      parseClientControlMessage('{"type":"signal","signal":"SIGTERM"}'),
    ).toEqual({
      type: "signal",
      signal: "SIGTERM",
    });
  });

  test("rejects malformed JSON, extra fields, empty argv, and unsupported signals", () => {
    for (const message of [
      "not-json",
      '{"type":"list","extra":true}',
      '{"type":"execute","argv":[],"cwd":"/project"}',
      '{"type":"execute","argv":[""],"cwd":"/project"}',
      '{"type":"execute","argv":["echo",1],"cwd":"/project"}',
      '{"type":"signal","signal":"SIGKILL"}',
    ]) {
      expect(() => parseClientControlMessage(message)).toThrow();
    }
  });

  test("validates broker messages and binary channel framing", () => {
    expect(
      parseBrokerControlMessage(
        '{"type":"allowed-commands","patterns":["[\\"tool\\",\\"safe\\"]"]}',
      ),
    ).toEqual({
      type: "allowed-commands",
      patterns: ['["tool","safe"]'],
    });
    expect(parseBrokerControlMessage('{"type":"exit","exitCode":127}')).toEqual(
      {
        type: "exit",
        exitCode: 127,
      },
    );
    expect(() =>
      parseBrokerControlMessage('{"type":"exit","exitCode":-1}'),
    ).toThrow();
    const framed = encodeBinaryChannel(
      STREAM_CHANNEL.stderr,
      Uint8Array.of(4, 5),
    );
    expect(decodeBinaryChannel(framed)).toEqual({
      channel: STREAM_CHANNEL.stderr,
      payload: Uint8Array.of(4, 5),
    });
    expect(() => decodeBinaryChannel(Uint8Array.of(4, 1))).toThrow();
    expect(() => decodeBinaryChannel(Uint8Array.of(1))).toThrow();
  });
});
