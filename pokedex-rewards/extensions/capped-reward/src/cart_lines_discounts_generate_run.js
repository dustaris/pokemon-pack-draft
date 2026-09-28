import { DiscountClass, OrderDiscountSelectionStrategy } from '../generated/api';

/**
 * Pokédex Pack Draft reward codes: pct% off the order subtotal, never more than `cap` dollars,
 * and only when the subtotal is at least `min` dollars. Settings come from the code's $app:config metafield.
 * @param {import("../generated/api").CartInput} input
 * @returns {import("../generated/api").CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const none = { operations: [] };
  if (!input.discount.discountClasses.includes(DiscountClass.Order)) return none;
  const cfg = (input.discount.metafield && input.discount.metafield.jsonValue) || {};
  const pct = Number(cfg.pct) || 0, cap = Number(cfg.cap) || 50, min = Number(cfg.min) || 0;
  const subtotal = Number(input.cart.cost.subtotalAmount.amount);
  if (pct <= 0 || !(subtotal >= min)) return none;
  const off = Math.min(cap, Math.floor(subtotal * pct) / 100); // round down to the cent
  if (off <= 0) return none;
  return {
    operations: [{
      orderDiscountsAdd: {
        candidates: [{
          message: off >= cap ? `${pct}% off (max $${cap})` : `${pct}% off`,
          targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
          value: { fixedAmount: { amount: off.toFixed(2) } },
        }],
        selectionStrategy: OrderDiscountSelectionStrategy.First,
      },
    }],
  };
}
