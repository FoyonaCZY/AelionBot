// The part of a Bot's personality that travels in a Bot file: its traits, where they started and its preset. What it
// feels about other members, its experiences and its highlights name Bots and matches of this computer and stay.
import { isPresetId } from '../../../shared/persona/presets';
import { TRAITS, roundTraits, type Traits } from '../../../shared/persona/persona-model';
import type { PersonaProfile } from '../../../shared/types/persona-types';
import type { PersonaService } from './persona-service';

export interface PortablePersona {
  traits: Traits;
  anchor: Traits;
  locked: boolean;
  confirmed: boolean;
  source: PersonaProfile['source'];
  preset?: string;
  facets?: Record<string, number>;
}

export function portablePersona(service: PersonaService, botId: string): PortablePersona | undefined {
  const profile = service.store.profile(botId);
  if (!profile) return;
  return {
    traits: profile.traits,
    anchor: profile.anchor,
    locked: profile.locked,
    confirmed: profile.confirmed,
    source: profile.source,
    ...(profile.preset ? { preset: profile.preset } : {}),
    ...(profile.facets ? { facets: profile.facets } : {}),
  };
}

const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function traits(value: unknown): Traits | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  return TRAITS.every((key) => unit(input[key]))
    ? roundTraits(Object.fromEntries(TRAITS.map((key) => [key, input[key]])) as Traits)
    : undefined;
}

/** A personality read from a file, or undefined when it is not one. */
export function parsePortablePersona(value: unknown): PortablePersona | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>,
    current = traits(input.traits);
  if (!current) return;
  const facets =
    input.facets && typeof input.facets === 'object' && !Array.isArray(input.facets)
      ? Object.entries(input.facets as Record<string, unknown>).filter(
          ([key, facet]) => /^[A-Z][0-9]$/.test(key) && unit(facet),
        )
      : [];
  return {
    traits: current,
    anchor: traits(input.anchor) || current,
    locked: input.locked === true,
    confirmed: input.confirmed === true,
    source: (['mbti', 'bfi2', 'user', 'preset'] as const).find((source) => source === input.source) || 'user',
    ...(isPresetId(input.preset) ? { preset: input.preset } : {}),
    ...(facets.length ? { facets: Object.fromEntries(facets) as Record<string, number> } : {}),
  };
}

/** Gives a newly imported Bot the personality from its file. Growth starts over: its experiences stayed behind. */
export function adoptPersona(service: PersonaService, botId: string, value: PortablePersona, now = Date.now()) {
  // A preset brings its learned contents (motives, speech habits) with it.
  if (value.preset && isPresetId(value.preset)) service.applyPreset(botId, value.preset);
  const profile = service.ensureProfile(botId);
  Object.assign(profile, {
    traits: value.traits,
    anchor: value.anchor,
    n: 0,
    locked: value.locked,
    confirmed: value.confirmed,
    source: value.preset ? 'preset' : value.source,
    updatedAt: now,
  });
  if (value.facets) profile.facets = value.facets;
  else delete profile.facets;
  service.store.saveProfile(profile);
  service.store.addHistory(botId, profile.traits, '从 Bot 文件导入', now);
}
