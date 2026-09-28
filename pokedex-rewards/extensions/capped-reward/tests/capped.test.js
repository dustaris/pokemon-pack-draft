import { describe, it, expect } from 'vitest';
import { cartLinesDiscountsGenerateRun } from '../src/cart_lines_discounts_generate_run';

const run = (subtotal, cfg, classes = ['ORDER']) => cartLinesDiscountsGenerateRun({
  cart: { cost: { subtotalAmount: { amount: String(subtotal) } } },
  discount: { discountClasses: classes, metafield: cfg ? { jsonValue: cfg } : null },
});
const amount = r => r.operations.length ? r.operations[0].orderDiscountsAdd.candidates[0].value.fixedAmount.amount : null;
const cfg = { pct: 20, cap: 50, min: 25 };

describe('capped reward discount', () => {
  it('takes the percentage on normal orders', () => expect(amount(run(120, cfg))).toBe('24.00'));
  it('caps big orders at $50', () => expect(amount(run(600, cfg))).toBe('50.00'));
  it('says when the cap applied', () => expect(run(600, cfg).operations[0].orderDiscountsAdd.candidates[0].message).toBe('20% off (max $50)'));
  it('needs the $25 minimum', () => expect(run(24.99, cfg).operations).toEqual([]));
  it('applies right at the minimum', () => expect(amount(run(25, cfg))).toBe('5.00'));
  it('rounds down to the cent', () => expect(amount(run(33.33, { pct: 15, cap: 50, min: 25 }))).toBe('4.99'));
  it('does nothing without a config', () => expect(run(100, null).operations).toEqual([]));
  it('does nothing for non-order discount classes', () => expect(run(100, cfg, ['PRODUCT']).operations).toEqual([]));
});
