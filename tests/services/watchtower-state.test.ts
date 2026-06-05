import { describe, expect, it } from "vitest";
import { initialState, parseStoredState } from "@/lib/storage/file-store";

describe("watchtower state shape", () => {
  it("initializes watchtower collections", () => {
    const state = initialState();

    expect(state.people).toEqual([]);
    expect(state.chatIdentities).toEqual([]);
    expect(state.conversations).toEqual([]);
    expect(state.pendingWorkOrderSessions).toEqual([]);
    expect(state.outboundMessages).toEqual([]);
  });

  it("migrates old stored state with watchtower defaults", () => {
    const state = parseStoredState(JSON.stringify({
      booths: [],
      tickets: [],
      messageRecords: [],
      config: { issueTypes: [], aiModels: [], assignmentRules: [] }
    }));

    expect(state.people).toEqual([]);
    expect(state.chatIdentities).toEqual([]);
    expect(state.conversations).toEqual([]);
    expect(state.pendingWorkOrderSessions).toEqual([]);
    expect(state.outboundMessages).toEqual([]);
    expect(state.config.messageIntegrations).toHaveLength(2);
    expect(state.config.messageIntegrations?.map((item) => item.channel)).toEqual(expect.arrayContaining(["wechat", "wecom"]));
  });

  it("migrates stored state without config", () => {
    const state = parseStoredState(JSON.stringify({
      booths: [],
      tickets: [],
      messageRecords: []
    }));

    expect(state.outboundMessages).toEqual([]);
    expect(state.config).toBeDefined();
    expect(state.config.messageIntegrations).toHaveLength(2);
    expect(state.config.messageIntegrations?.map((item) => item.channel)).toEqual(expect.arrayContaining(["wechat", "wecom"]));
  });
});
