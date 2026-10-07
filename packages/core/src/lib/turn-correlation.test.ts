import { describe, expect, it } from "vitest";
import {
  extractTurnCorrelation,
  TURN_CORRELATION_ARG,
  TURN_CORRELATION_MAX_ID_LENGTH,
  type TurnCorrelation,
  turnCorrelationKey,
} from "./turn-correlation.js";

const SESSION = "ea34d2b8-84f8-4023-a09e-f6b6ba4db6fb";
const TURN = "b08207f6-4fc6-472b-822b-2008a0d6e424";

describe("extractTurnCorrelation", () => {
  it("reserves the _ratel argument name", () => {
    expect(TURN_CORRELATION_ARG).toBe("_ratel");
  });

  it("strips a valid field and returns the correlation", () => {
    const input = { query: "q", _ratel: { session: SESSION, turn: TURN, agent: "a1" } };
    const { args, correlation } = extractTurnCorrelation(input);
    expect(args).toEqual({ query: "q" });
    expect(correlation).toEqual({ session: SESSION, turn: TURN, agent: "a1" });
    expect(input).toHaveProperty("_ratel");
  });

  it("returns arguments unchanged and no correlation when the field is absent", () => {
    const input = { query: "q" };
    const { args, correlation } = extractTurnCorrelation(input);
    expect(args).toBe(input);
    expect(correlation).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["a string", "s:t"],
    ["an array", [SESSION, TURN]],
    ["a missing turn", { session: SESSION }],
    ["a missing session", { turn: TURN }],
    ["an empty session", { session: "", turn: TURN }],
    ["a numeric turn", { session: SESSION, turn: 7 }],
    ["an empty agent", { session: SESSION, turn: TURN, agent: "" }],
    ["a non-string agent", { session: SESSION, turn: TURN, agent: 1 }],
    ["an over-long id", { session: "s".repeat(TURN_CORRELATION_MAX_ID_LENGTH + 1), turn: TURN }],
  ])("strips but ignores a field with %s", (_label, value) => {
    const { args, correlation } = extractTurnCorrelation({ query: "q", _ratel: value });
    expect(args).toEqual({ query: "q" });
    expect(correlation).toBeUndefined();
  });

  it("ignores unknown keys inside a valid field", () => {
    const { correlation } = extractTurnCorrelation({
      _ratel: { session: SESSION, turn: TURN, host: "claude-code" },
    });
    expect(correlation).toEqual({ session: SESSION, turn: TURN });
  });
});

describe("turnCorrelationKey", () => {
  it("is stable for the same correlation", () => {
    const c = { session: SESSION, turn: TURN };
    expect(turnCorrelationKey(c)).toBe(turnCorrelationKey({ ...c }));
  });

  it("separates the main thread from a subagent, and subagents from each other", () => {
    const main = turnCorrelationKey({ session: SESSION, turn: TURN });
    const a = turnCorrelationKey({ session: SESSION, turn: TURN, agent: "a" });
    const b = turnCorrelationKey({ session: SESSION, turn: TURN, agent: "b" });
    expect(new Set([main, a, b]).size).toBe(3);
  });

  it("cannot collide when ids contain the separator or escape characters", () => {
    const cases: TurnCorrelation[] = [
      { session: "a:b", turn: "c" },
      { session: "a", turn: "b:c" },
      { session: "a", turn: "b", agent: "c" },
      { session: "a", turn: "b:c", agent: "d" },
      { session: "a:b", turn: "c", agent: "d" },
      { session: "a", turn: "b", agent: "c:d" },
      { session: "a%3Ab", turn: "c" },
      { session: "a", turn: "%3A" },
      { session: "rt1", turn: "a" },
    ];
    const keys = cases.map(turnCorrelationKey);
    expect(new Set(keys).size).toBe(cases.length);
  });

  it("never equals a bare connection UUID", () => {
    expect(turnCorrelationKey({ session: SESSION, turn: TURN })).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("keeps plain ids readable", () => {
    expect(turnCorrelationKey({ session: "s1", turn: "t1", agent: "a1" })).toBe("rt1:s1:t1:a1");
  });
});
