// Who may start and stop a take for everyone in a live session.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn() } }));

const { canControlRecording, otherDevicesOf, roomMembersFrom } = await import("../src/sockets/websocket.js");

describe("canControlRecording", () => {
  const session = { created_by: 1, owner_id: 2 };

  it("lets the session's creator, the group's owner and its admins control takes", () => {
    expect(canControlRecording({ ...session, role: "member" }, 1)).toBe(true);
    expect(canControlRecording({ ...session, role: "admin" }, 2)).toBe(true);
    expect(canControlRecording({ ...session, role: "admin" }, 3)).toBe(true);
  });

  it("leaves other members and viewers following the host", () => {
    expect(canControlRecording({ ...session, role: "member" }, 3)).toBe(false);
    expect(canControlRecording({ ...session, role: "viewer" }, 3)).toBe(false);
  });

  it("compares ids whether they arrive as numbers or strings", () => {
    expect(canControlRecording({ created_by: "1", owner_id: "2", role: "member" }, 1)).toBe(true);
  });
});

describe("roomMembersFrom", () => {
  const socket = (id, camera) => ({ data: { user: { id, name: `User ${id}` }, camera } });

  it("marks controllers apart from cameras", () => {
    const members = roomMembersFrom([socket(1, false), socket(2, true), socket(3, undefined)]);
    expect(members.map((m) => [m.id, m.camera])).toEqual([[1, false], [2, true], [3, true]]);
  });

  it("lists someone once, as recording if any of their devices is", () => {
    const members = roomMembersFrom([socket(1, false), socket(1, true), { data: {} }]);
    expect(members).toEqual([{ id: 1, name: "User 1", camera: true, roundTripMs: null }]);
  });

  it("gives each person their slowest device's round trip", () => {
    const timed = (id, roundTripMs) => ({ data: { user: { id }, roundTripMs } });
    const members = roomMembersFrom([timed(1, 80.4), timed(1, 650), timed(2, 120), timed(3, undefined)]);
    expect(members.map((m) => [m.id, m.roundTripMs])).toEqual([[1, 650], [2, 120], [3, null]]);
  });
});

describe("otherDevicesOf", () => {
  const sock = (id, userId, deviceId) => ({ id, data: { user: { id: userId }, deviceId } });

  it("keeps a second device on the same account out", () => {
    const me = sock("new", 7, "phone-b");
    const { elsewhere } = otherDevicesOf([sock("old", 7, "phone-a"), me], me);
    expect(elsewhere.map((s) => s.id)).toEqual(["old"]);
  });

  it("lets the same device back in, replacing its old connection", () => {
    const me = sock("new", 7, "phone-a");
    const result = otherDevicesOf([sock("old", 7, "phone-a"), me], me);
    expect(result.elsewhere).toEqual([]);
    expect(result.staleHere.map((s) => s.id)).toEqual(["old"]);
  });

  it("ignores other accounts", () => {
    const me = sock("new", 7, "phone-a");
    expect(otherDevicesOf([sock("x", 8, "phone-z"), me], me).elsewhere).toEqual([]);
  });

  it("doesn't block between two older apps that send no id", () => {
    const me = sock("new", 7, null);
    expect(otherDevicesOf([sock("old", 7, undefined), me], me).elsewhere).toEqual([]);
  });

  it("blocks an older app joining where a newer one already is", () => {
    const me = sock("new", 7, null);
    expect(otherDevicesOf([sock("old", 7, "phone-a"), me], me).elsewhere).toHaveLength(1);
  });
});
