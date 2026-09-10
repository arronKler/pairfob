import { describe, expect, test } from "bun:test";
import {
  adoptChatDetailsOwner,
  chatDetailChoice,
  choiceFromDetails,
  recordChatDetailChoice,
  resetChatDetails,
} from "./details";

describe("chat details ownership", () => {
  test("records choices until the session owner changes", () => {
    resetChatDetails();
    adoptChatDetailsOwner("1:p1:1");
    recordChatDetailChoice("tool-a", true);
    recordChatDetailChoice("tool-b", false);
    expect(chatDetailChoice("tool-a")).toBeTrue();
    expect(chatDetailChoice("tool-b")).toBeFalse();
    expect(chatDetailChoice("tool-c")).toBeNull();
    adoptChatDetailsOwner("1:p1:1");
    expect(chatDetailChoice("tool-a")).toBeTrue();
    adoptChatDetailsOwner("1:p2:1");
    expect(chatDetailChoice("tool-a")).toBeNull();
  });

  test("a retired owner cannot record a choice into the current owner", () => {
    resetChatDetails();
    adoptChatDetailsOwner("A:p1:1");
    adoptChatDetailsOwner("B:p1:1");
    expect(recordChatDetailChoice("same-tool", true, "A:p1:1")).toBeFalse();
    expect(chatDetailChoice("same-tool")).toBeNull();
    expect(recordChatDetailChoice("same-tool", true, "B:p1:1")).toBeTrue();
    expect(chatDetailChoice("same-tool")).toBeTrue();
  });

  test("an explicit snapshot wins over the stored choice for one mount", () => {
    resetChatDetails();
    adoptChatDetailsOwner("1:p1:1");
    recordChatDetailChoice("tool-a", true);
    const kept = { open: new Set<string>(), closed: new Set(["tool-a"]) };
    expect(choiceFromDetails(kept, "tool-a")).toBeFalse();
    expect(choiceFromDetails(undefined, "tool-a")).toBeTrue();
  });
});
