/** Golden vectors for cross-adapter location-handle conformance guards (memex-core#32). */
export const LOCATION_ROUND_TRIP_GOLDEN = [
  {
    label: "grok-global skill",
    absolute: "/home/user/.grok/skills/weather/SKILL.md",
    handle: "memex://grok-global/weather/SKILL.md",
  },
  {
    label: "grok-project skill",
    absolute: "/home/user/project/.grok/skills/deploy/SKILL.md",
    handle: "memex://grok-project/deploy/SKILL.md",
  },
  {
    label: "sync-skills copy",
    absolute: "/home/user/.memex/sync/skills/weather/SKILL.md",
    handle: "memex://sync-skills/weather/SKILL.md",
  },
  {
    label: "unclassified extra dir (path-hash stable)",
    absolute: "/opt/extra/skills/custom/SKILL.md",
    handle: "memex://skill-unclassified-067ae16e/custom/SKILL.md",
  },
] as const;