import { describe, expect, it } from "vitest";
import { setSetting } from "./config.js";
import { chooseRoute, RouteNeeded } from "./route.js";
import { openStore } from "./store.js";

describe("chooseRoute", () => {
  const db = openStore(":memory:");
  setSetting(db, "global", "", "forge.glab_hosts", ["gitlab.internal"]);
  const route = (url: string, choice: Parameters<typeof chooseRoute>[2] = {}) => chooseRoute(db, url, choice);

  it("works out pull requests for github.com and merge requests for a listed GitLab host", () => {
    expect(route("https://github.com/ultish/yagura-sandbox.git")).toEqual({ forge: "gh", pushConfirmed: false });
    expect(route("git@github.com:ultish/yagura-sandbox.git")).toEqual({ forge: "gh", pushConfirmed: false });
    expect(route("git@gitlab.internal:team/billing.git")).toEqual({ forge: "glab", pushConfirmed: false });
    expect(route("https://GITLAB.internal/team/billing.git")).toEqual({ forge: "glab", pushConfirmed: false });
  });

  it("refuses to guess for any other remote, and takes an explicit choice", () => {
    expect(() => route("git@git.example.com:team/x.git")).toThrow(RouteNeeded);
    expect(() => route("git@git.example.com:team/x.git")).toThrow(/forge gh.*forge glab.*land push/);
    expect(() => route("https://github.com/o/r.git", { forge: "none" })).toThrow(/has to be chosen as such \(land push\)/);
    expect(route("git@git.example.com:team/x.git", { forge: "glab" })).toEqual({ forge: "glab", pushConfirmed: false });
    expect(route("git@git.example.com:team/x.git", { land: "push" })).toEqual({ forge: "none", pushConfirmed: true });
  });

  it("lets a local or file:// repo push without asking", () => {
    expect(route("/tmp/origin.git")).toEqual({ forge: "none", pushConfirmed: true });
    expect(route("file:///tmp/origin.git")).toEqual({ forge: "none", pushConfirmed: true });
  });
});
