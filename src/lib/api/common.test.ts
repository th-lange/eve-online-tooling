import { describe, expect, it } from "vitest";
import { errorMessage, isAuthRequired } from "./common";

describe("isAuthRequired", () => {
  it("is true for the parsed Rust AppError::AuthRequired wire shape", () => {
    // Wire shape pinned against src-tauri/src/model/mod.rs
    // error_tests::auth_required_serializes_with_a_kind_tag — if that Rust
    // test's assertions change (tag name, field names), this fixture and
    // that test will fall out of sync; check both on a failure.
    const e: unknown = JSON.parse(
      '{"kind":"authRequired","message":"Log in a character first"}',
    );
    expect(isAuthRequired(e)).toBe(true);
  });

  it("is false for a structured message-kind error", () => {
    expect(isAuthRequired({ kind: "message", message: "boom" })).toBe(false);
  });

  it("is false for a plain string rejection", () => {
    expect(isAuthRequired("boom")).toBe(false);
  });

  it("is false for an Error instance", () => {
    expect(isAuthRequired(new Error("boom"))).toBe(false);
  });

  it("is false for null", () => {
    expect(isAuthRequired(null)).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isAuthRequired(undefined)).toBe(false);
  });

  it("is false for an object missing the message field", () => {
    expect(isAuthRequired({ kind: "authRequired" })).toBe(false);
  });
});

describe("errorMessage", () => {
  it("returns .message for a structured authRequired error", () => {
    const e: unknown = JSON.parse(
      '{"kind":"authRequired","message":"Log in a character first"}',
    );
    expect(errorMessage(e)).toBe("Log in a character first");
  });

  it("returns .message for a structured message error", () => {
    expect(errorMessage({ kind: "message", message: "boom" })).toBe("boom");
  });

  it("falls back to String(e) for a legacy plain-string rejection", () => {
    expect(errorMessage("boom")).toBe("boom");
  });

  it("falls back to String(e) for a legacy Error rejection", () => {
    expect(errorMessage(new Error("boom"))).toBe("Error: boom");
  });
});
