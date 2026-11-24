// Locality: the countries where a project's machines may run, from the project's preset and its
// optional extra country list.

import type { CountryCode, LocalityPreset } from "@sbgpu/api";

/** The 27 EU member states. */
export const EU_COUNTRIES: readonly CountryCode[] = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];

/** The rest of the EEA: Iceland, Liechtenstein, Norway. */
export const EEA_NON_EU: readonly CountryCode[] = ["IS", "LI", "NO"];

/** Countries per preset; "any" is every country, including unknown ones. */
export const PRESET_COUNTRIES: Readonly<Record<Exclude<LocalityPreset, "any">, readonly CountryCode[]>> = {
  // "Europe" as decided for the pilot (Nov 16): the EU, the rest of the EEA, and the UK.
  europe: [...EU_COUNTRIES, ...EEA_NON_EU, "GB"],
  eu: EU_COUNTRIES,
  uk: ["GB"],
  us: ["US"],
  ca: ["CA"],
};

export type Locality = readonly CountryCode[] | "any";

/** The preset's countries, narrowed to `allowedCountries` when that isn't null. */
export function localityFor(preset: LocalityPreset, allowedCountries: readonly CountryCode[] | null): Locality {
  const base: Locality = preset === "any" ? "any" : PRESET_COUNTRIES[preset];
  if (allowedCountries === null) return base;
  return base === "any" ? [...allowedCountries] : base.filter((c) => allowedCountries.includes(c));
}

/** Whether a machine in `country` is allowed. An unknown country matches only "any". */
export function countryAllowed(locality: Locality, country: CountryCode | null): boolean {
  if (locality === "any") return true;
  return country !== null && locality.includes(country);
}
