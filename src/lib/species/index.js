import fieldOak from './field_oak';
import silverBirch from './silver_birch';
import beech from './beech';
import norwaySpruce from './norway_spruce';
import stonePine from './stone_pine';
import weepingWillow from './weeping_willow';
import maritimePine from './maritime_pine';
import umbrellaAcacia from './umbrella_acacia';
import olive from './olive';
import mesquite from './mesquite';
import juniper from './juniper';
import pinyonPine from './pinyon_pine';
import alder from './alder';
import baldCypress from './bald_cypress';
import { speciesVariantOptions, variantInfo } from './model';

export {
  VARIANT_COUNT, hash, stratum, variantInfo, speciesWind, speciesSets,
} from './model';

/**
 * Author-approved roster, keyed by catalog id, in roster order.
 * @type {Object<string, import('./model').SpeciesDef>}
 */
export const SPECIES = Object.fromEntries([
  fieldOak, silverBirch, beech, norwaySpruce, stonePine,
  weepingWillow, maritimePine, umbrellaAcacia, olive, mesquite,
  juniper, pinyonPine, alder, baldCypress,
].map((species) => [species.id, species]));

/** @returns {import('./model').SpeciesDef} */
export function getSpecies(speciesId) {
  const species = SPECIES[speciesId];
  if (!species) throw new RangeError(`Unknown species '${speciesId}'`);
  return species;
}

/**
 * Deterministic TreeOptions for variant `index` (0..9) of a species.
 * @param {string} speciesId
 * @param {number} index
 */
export function variantOptions(speciesId, index) {
  return speciesVariantOptions(getSpecies(speciesId), index);
}

/** Variant name, file stem and target height (m). */
export function variantMeta(speciesId, index) {
  return variantInfo(getSpecies(speciesId), index);
}
