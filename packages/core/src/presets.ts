import type { EnvironmentId } from "./domain.js";
import { listValues, setValue } from "./envvalues.js";
import { getEnvironment, type Db } from "./store.js";

export interface PresetValue {
  name: string;
  value: string;
  note: string;
}

export interface Preset {
  id: string;
  label: string;
  values: PresetValue[];
}

// Shortcuts only: they add ordinary values the developer then edits. Addresses are examples to overwrite.
export const PRESETS: Preset[] = [
  {
    id: "registry",
    label: "registry",
    values: [
      {
        name: "REGISTRY_PUSH",
        value: "localhost:5000",
        note: "Push images here from this machine (jib, docker push). Tag them with $YAGURA_SHA.",
      },
      {
        name: "REGISTRY_PULL",
        value: "hostname:5000",
        note: "The same registry as the cluster sees it. Use it in image references in helm values and manifests.",
      },
    ],
  },
  {
    id: "kafka",
    label: "kafka",
    values: [
      {
        name: "KAFKA_BOOTSTRAP_CLUSTER",
        value: "kafka.kafka.svc:9092",
        note: "Kafka bootstrap servers as pods see them. Use this in charts and manifests.",
      },
      {
        name: "KAFKA_BOOTSTRAP_LOCAL",
        value: "hostname:30092",
        note: "Kafka bootstrap servers from this machine, for tests run here. Never put this in a chart.",
      },
    ],
  },
  { id: "helm", label: "helm", values: [{ name: "HELM", value: "helm", note: "Run helm as $HELM." }] },
  {
    id: "skaffold",
    label: "skaffold",
    values: [{ name: "SKAFFOLD", value: "skaffold", note: "Run skaffold as $SKAFFOLD." }],
  },
  {
    id: "maven-mirror",
    label: "maven mirror",
    values: [
      {
        name: "MAVEN_MIRROR",
        value: "https://nexus.example/repository/maven-public/",
        note: "The only Maven repository reachable; builds run offline against it.",
      },
    ],
  },
];

// Existing names stay as the developer left them. A preset never overwrites.
export function applyPreset(db: Db, environmentId: EnvironmentId, presetId: string): { added: string[]; skipped: string[] } {
  getEnvironment(db, environmentId);
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`no preset ${presetId}`);
  const existing = new Set(listValues(db, environmentId).map((v) => v.name));
  const added = preset.values.filter((v) => !existing.has(v.name));
  for (const v of added) setValue(db, environmentId, { ...v, source: preset.id });
  return { added: added.map((v) => v.name), skipped: preset.values.filter((v) => existing.has(v.name)).map((v) => v.name) };
}
