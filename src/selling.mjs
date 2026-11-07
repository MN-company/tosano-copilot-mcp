/** Selling rules from productInfos, mirroring the site's own quantity logic (app.js:
 * encodeProductQuantity / plus / minus / getMultiplier). Only selling fields are read;
 * productInfos also carries internal fields (e.g. MAIL_TO) that never reach MCP.
 *
 * TIPOLOGIA Pezzo / Confezione: integer pieces, multiples of QTY_MULT, at least MINACQ.
 *   Confezione with WEIGHT_UNIT_SELLING is a variable-weight pack (fruit, deli): you
 *   order pieces of ~WEIGHT_SELLING and pay the real weight.
 * TIPOLOGIA Sfuso: the cart quantity is a weight in WEIGHT_UNIT_BASE; the user picks it in
 *   WEIGHT_UNIT_SELLING, starting at WEIGHT_SELLING in steps of STEP_SELLING.
 */
import { TosanoError } from './client.mjs';

const UNIT = { g: 1000, gr: 1000, kg: 1, hg: 10, dag: 100, ml: 1000, cl: 100, lt: 1, l: 1 };
const num = v => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const round3 = n => Math.round(n * 1000) / 1000;

export function sellingView(p = {}) {
  const i = p.productInfos ?? {};
  const type = ['Pezzo', 'Confezione', 'Sfuso'].includes(i.TIPOLOGIA) ? i.TIPOLOGIA : null;
  const sellUnit = (i.WEIGHT_UNIT_SELLING || '').toLowerCase() || null;
  const baseUnit = (i.WEIGHT_UNIT_BASE || 'kg').toLowerCase();
  const multiplier = sellUnit && UNIT[sellUnit] && UNIT[baseUnit] ? UNIT[sellUnit] / UNIT[baseUnit] : 1;
  const ws = num(i.WEIGHT_SELLING);
  const weightKg = ws !== null ? round3(sellUnit ? ws / multiplier : ws) : null;
  return {
    type,
    variableWeight: type === 'Sfuso' || (type === 'Confezione' && Boolean(sellUnit)),
    estimatedWeightKg: type === 'Sfuso' ? null : weightKg,
    sellUnit, baseUnit, multiplier,
    minWeight: type === 'Sfuso' ? ws : null,
    step: type === 'Sfuso' ? num(i.STEP_SELLING) : null,
    qtyMultiple: num(i.QTY_MULT) ?? 1,
    minQuantity: num(i.MINACQ) ?? 1,
    maxQuantity: num(i.MAXACQ),
    dayLock: typeof p.dayLock === 'string' && p.dayLock.trim() ? p.dayLock.trim().slice(0, 60) : null
  };
}

/** Options such as slicing thickness: [{parameterName, name, choices:[{key,value}]}]. */
export function optionsView(p = {}) {
  return (Array.isArray(p.selectOptions) ? p.selectOptions : []).map(o => ({
    parameterName: typeof o.parameterName === 'string' ? o.parameterName.slice(0, 60) : null,
    name: typeof o.name === 'string' ? o.name.slice(0, 80) : null,
    choices: (Array.isArray(o.options) ? o.options : []).map(c => ({ key: String(c.key ?? '').slice(0, 60), value: String(c.value ?? '').slice(0, 80) })).filter(c => c.value)
  })).filter(o => o.parameterName && o.choices.length);
}

/** Validate the requested amount against site rules. Never silently rounds: on a mismatch
 * it throws with the nearest valid values so the user can choose.
 * Pezzo/Confezione: `quantity` = pieces. Sfuso: `quantity` = weight in the SELLING unit (e.g. grams). */
export function encodeQuantity(selling, quantity) {
  if (!selling?.type) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new TosanoError('Invalid quantity', 'INVALID_ARGUMENT');
    return { cartQuantity: quantity, display: `${quantity} pz` };
  }
  if (selling.type === 'Sfuso') {
    const min = selling.minWeight ?? 0, step = selling.step;
    if (!(typeof quantity === 'number' && quantity > 0)) throw new TosanoError('Invalid weight', 'INVALID_ARGUMENT');
    if (quantity < min) throw Object.assign(new TosanoError(`Peso minimo ${min} ${selling.sellUnit}`, 'QUANTITY_RULE'), { details: { min, step, unit: selling.sellUnit } });
    if (step && Math.abs(((quantity - min) / step) - Math.round((quantity - min) / step)) > 1e-6) {
      const lower = round3(min + Math.floor((quantity - min) / step) * step);
      throw Object.assign(new TosanoError(`Il peso va a scatti di ${step} ${selling.sellUnit}`, 'QUANTITY_RULE'), { details: { suggestions: [lower, round3(lower + step)], unit: selling.sellUnit } });
    }
    const cartQuantity = round3(quantity / selling.multiplier);
    if (cartQuantity > 50) throw new TosanoError('Weight above 50 kg', 'INVALID_ARGUMENT');
    return { cartQuantity, display: `${quantity} ${selling.sellUnit}` };
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new TosanoError('Pieces must be a whole number 1-100', 'INVALID_ARGUMENT');
  const m = selling.qtyMultiple > 1 ? selling.qtyMultiple : 1;
  if (quantity < selling.minQuantity) throw Object.assign(new TosanoError(`Minimo ${selling.minQuantity} pz`, 'QUANTITY_RULE'), { details: { min: selling.minQuantity } });
  if (selling.maxQuantity && quantity > selling.maxQuantity) throw Object.assign(new TosanoError(`Massimo ${selling.maxQuantity} pz`, 'QUANTITY_RULE'), { details: { max: selling.maxQuantity } });
  if (quantity % m) throw Object.assign(new TosanoError(`Si acquista a multipli di ${m}`, 'QUANTITY_RULE'), { details: { suggestions: [quantity - (quantity % m) || m, quantity - (quantity % m) + m] } });
  return { cartQuantity: quantity, display: `${quantity} pz` + (selling.variableWeight && selling.estimatedWeightKg ? ` (~${round3(quantity * selling.estimatedWeightKg)} kg)` : '') };
}

/** Variable-weight estimate: price per kg x estimated weight. Always labelled as estimate. */
export function estimateLine(selling, pricePerKg, quantity) {
  if (!selling?.variableWeight || !Number.isFinite(pricePerKg)) return null;
  const kg = selling.type === 'Sfuso' ? quantity : (selling.estimatedWeightKg ?? NaN) * quantity;
  if (!Number.isFinite(kg)) return null;
  return { estimatedKg: round3(kg), estimatedPrice: Math.round(pricePerKg * kg * 100) / 100,
    note: 'Stima: si paga il peso effettivo, che può variare.' };
}

export function validateOptions(productOptions, chosen) {
  if (!chosen || !Object.keys(chosen).length) {
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(chosen)) {
    const o = productOptions.find(x => x.parameterName === k);
    if (!o) throw new TosanoError(`Option ${k} not offered for this product`, 'INVALID_OPTION');
    const c = o.choices.find(x => x.key === v || x.value === v);
    if (!c) throw Object.assign(new TosanoError(`Value not offered for ${o.name}`, 'INVALID_OPTION'), { details: { choices: o.choices } });
    out[k] = c.key || c.value;
  }
  return out;
}
