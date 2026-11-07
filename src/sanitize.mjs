import { labelFromProduct } from './label.mjs';
import { sellingView, optionsView } from './selling.mjs';
/** Responses from EBSN include personal profile, address and payment data. NEVER return them raw to MCP. */
export function productView(p = {}) {
  const label = labelFromProduct(p);
  const fromLabel = label.source ? {
    ingredients: label.ingredients,
    allergens: label.declared ? label.declared.contains : null,
    possibleTraces: label.declared ? label.declared.mayContain : (label.precautions.length ? label.precautions : null),
    label
  } : { label };
  return {
    productId: p.productId ?? p.id ?? null,
    name: [p.name, p.description].filter(Boolean).join(' ').trim(),
    brand: p.vendor?.name ?? p.shortDescr ?? null,
    sizeLabel: p.description ?? null,
    barcode: p.barcode ?? null,
    slug: p.slug ?? null,
    unitPrice: p.priceDisplay ?? p.price ?? null,
    pricePerUnit: p.priceStandardUmDisplay ?? null,
    unit: p.weightUnitDisplay ?? null,
    category: p.breadCrumbs?.map?.(c => c.name).slice(-1)[0] ?? null,
    classes: (p.productClasses ?? []).map(c => typeof c === 'string' ? c : c?.name).filter(Boolean),
    images: (p.media ?? []).filter(m => m.type === 'front' || m.type === 'back').map(m => ({ type: m.type, url: m.medium })),
    hasStructuredNutrition: Boolean(p.nutrition || p.nutritionalValues),
    ingredients: typeof p.ingredients === 'string' ? p.ingredients : null,
    allergens: Array.isArray(p.allergens) && p.allergens.every(x=>typeof x==='string') ? p.allergens : null,
    // Only an explicit structured declaration can clear trace checks; no name/OCR inference.
    possibleTraces: Array.isArray(p.possibleTraces) && p.possibleTraces.every(x=>typeof x==='string') ? p.possibleTraces : null,
    // The backend's huge 'available' sentinel is not evidence of physical stock.
    availabilityConfirmed: false,
    selling: sellingView(p),
    options: optionsView(p),
    ...fromLabel
  };
}
export function searchView(data = {}) {
  return {
    page: data.page?.selPage ?? null,
    totalPages: data.page?.totPages ?? null,
    totalProducts: data.page?.totItems ?? null,
    products: (data.products ?? []).map(productView)
  };
}
export function cartView(data = {}, options = {}) {
  return {
    source: options.source ?? 'mutation_response',
    live: options.live ?? true,
    observedAt: new Date().toISOString(),
    cartId: data.cartId ?? null,
    subtotal: data.totalPrice ?? null,
    deliveryFee: data.deliveryFee ?? null,
    packagingFee: data.packageTotal ?? null,
    total: data.grossTotal ?? null,
    totalItems: data.totalItems ?? null,
    mode: data.shippingAddress?.addressType ?? (data.homeDelivery ? 'delivery' : null),
    pickupOrDeliveryLocation: data.shippingAddress?.addressName ?? null,
    timeslot: data.timeslot ? { date: data.timeslot.date, name: data.timeslot.name } : null,
    items: (data.cartItems ?? []).map(i => ({
      itemId: i.itemId,
      productId: i.product?.productId,
      slug: i.product?.slug ?? null,
      name: i.product?.name,
      brand: i.product?.vendor?.name ?? i.product?.shortDescr,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      total: i.grossTotal,
      acceptAlternatives: i.cartItemInfo?.accept_alternatives === 'true'
    }))
  };
}
