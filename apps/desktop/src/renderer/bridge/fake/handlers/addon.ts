/**
 * The fake main's TaleSpire add-on and link channels. Install always succeeds (unless there is no folder or a foreign
 * one); a send loads the build into a pretend add-on that reports chunk 1 of n in hand.
 */
import { fail, type FakeState, type HandlerGroup } from "../state";
import { fakeAddonStatus, fakeLinkStatus } from "../talespireLink";

type AddonChannels =
  | "addon:status"
  | "addon:install"
  | "addon:chooseFolder"
  | "addon:uninstall"
  | "addon:openFolder"
  | "addon:dismissPrompt"
  | "link:status"
  | "link:send"
  | "link:stop";

export function addonHandlers(s: FakeState): HandlerGroup<AddonChannels> {
  const setAddon = (a: FakeState["addon"]): FakeState["addon"] => {
    s.addon = a;
    s.emit("addon:changed", a);
    return a;
  };
  const setLink = (l: FakeState["link"]): void => {
    s.link = l;
    s.emit("link:changed", l);
  };
  return {
    "addon:status": () => s.addon,
    "addon:install": async () => {
      await s.sleep(400);
      if (s.addon.state === "not_found")
        return fail("not_found", "TaleSpire's Symbiotes folder wasn't found.");
      if (s.addon.state === "foreign")
        return fail("validation", "slabyrinth-helper in the Symbiotes folder belongs to another add-on.");
      const from = s.addon.installedVersion;
      const { folder, folderSource, folderWarning, elsewhere } = s.addon;
      const next = { ...fakeAddonStatus("installed"), folder, folderSource, folderWarning, elsewhere };
      return setAddon({
        ...next,
        update: {
          state: "updated",
          automatic: false,
          from,
          to: next.bundledVersion,
          at: new Date().toISOString(),
          error: null,
        },
      });
    },
    "addon:chooseFolder": async ({ reset }) => {
      await s.sleep(300);
      if (reset === true) return setAddon(fakeAddonStatus("missing"));
      const elsewhere =
        s.addon.installedVersion !== null && s.addon.folder !== null
          ? { folder: s.addon.folder, version: s.addon.installedVersion }
          : null;
      return setAddon({
        ...fakeAddonStatus("missing"),
        folder: "D:\\Games\\Symbiotes",
        folderSource: "manual",
        folderWarning:
          "This folder doesn't look like TaleSpire's Symbiotes folder (…/TaleSpire/Symbiotes). TaleSpire only loads add-ons from there.",
        elsewhere,
      });
    },
    "addon:uninstall": async ({ elsewhere }) => {
      await s.sleep(300);
      if (elsewhere === true) {
        if (!s.addon.elsewhere) return fail("not_found", "There is no add-on to remove there.");
        return setAddon({ ...s.addon, elsewhere: null });
      }
      if (s.addon.state === "foreign")
        return fail(
          "validation",
          "slabyrinth-helper belongs to another add-on, so Slabyrinth won't delete it.",
        );
      if (s.addon.installedVersion === null) return fail("not_found", "The add-on isn't installed there.");
      setLink(fakeLinkStatus({ helper: "none" }));
      return setAddon(fakeAddonStatus("missing"));
    },
    "addon:openFolder": ({ which }) => ({
      opened: which === "package" || s.addon.folder !== null,
      path:
        which === "package"
          ? "C:\\Users\\gm\\AppData\\Roaming\\Slabyrinth\\talespire-addon\\slabyrinth-helper"
          : s.addon.folder,
    }),
    "addon:dismissPrompt": ({ version }) => {
      s.settings.talespire.addonPromptDismissed = version;
      return setAddon({ ...s.addon, prompt: { show: false, reason: s.addon.prompt.reason } });
    },
    "link:status": () => s.link,
    "link:send": async ({ buildId }) => {
      if (s.link.helper.state !== "connected")
        return fail(
          "validation",
          "The TaleSpire add-on isn't connected. Open Slabyrinth Helper in TaleSpire.",
        );
      const p = s.open();
      const build = p.builds.find((b) => b.id === buildId);
      if (!build) return fail("not_found", "That build no longer exists.");
      const total = build.levels.reduce((n, l) => n + l.chunks.length, 0);
      setLink({ ...s.link, send: { state: "sending", buildId, chunks: total, error: null } });
      await s.sleep(300);
      setLink(
        fakeLinkStatus({ helper: "connected", placing: { name: p.name, chunk: 1, total, phase: "ready" } }),
      );
      return { chunks: total };
    },
    "link:stop": () => {
      setLink(fakeLinkStatus({ helper: s.link.helper.state }));
    },
  };
}
