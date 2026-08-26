"use strict";
/**
 * OpenRouter adapter - UI transcript parser for Paperclip.
 *
 * Served to the browser via the adapter's "./ui-parser" export
 * (paperclip.adapterUiParser contract 1.0.0). Must stay dependency-free,
 * plain CJS, and browser-safe.
 *
 * The server side of this adapter writes each TranscriptEntry as a single
 * JSON line on stdout, so parsing is: try JSON, validate the "kind"
 * discriminator, fall back to a raw stdout entry for anything else.
 */

var KNOWN_KINDS = [
  "assistant",
  "thinking",
  "user",
  "tool_call",
  "tool_result",
  "init",
  "result",
  "stderr",
  "system",
  "stdout",
  "diff",
];

function parseStdoutLine(line, ts) {
  var trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.charAt(0) === "{") {
    try {
      var entry = JSON.parse(trimmed);
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        KNOWN_KINDS.indexOf(entry.kind) !== -1 &&
        typeof entry.ts !== "undefined"
      ) {
        // Trust host timestamps over adapter clocks when provided.
        return [Object.assign({}, entry, { ts: ts || entry.ts })];
      }
    } catch (err) {
      // Fall through to the stdout fallback below.
    }
  }

  return [{ kind: "stdout", ts: ts, text: trimmed }];
}


function createStdoutParser() {
  var awaitingResult = false;
  var lastToolUseId = "";
  return {
    parseLine: function (line, ts) {
      var trimmed = line.trim();
      if (!trimmed) return [];
      if (trimmed.charAt(0) === "{") {
        try {
          var entry = JSON.parse(trimmed);
          if (
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            KNOWN_KINDS.indexOf(entry.kind) !== -1 &&
            typeof entry.ts !== "undefined"
          ) {
            if (entry.kind === "tool_result") awaitingResult = false;
            return [Object.assign({}, entry, { ts: ts || entry.ts })];
          }
        } catch (err) {}
      }
      if (awaitingResult) {
        awaitingResult = false;
        return [{ kind: "tool_result", ts: ts, toolUseId: lastToolUseId, content: trimmed, isError: false }];
      }
      return [{ kind: "assistant", ts: ts, text: trimmed }];
    },
    reset: function () {
      awaitingResult = false;
    },
  };
}

module.exports = { parseStdoutLine, createStdoutParser };
