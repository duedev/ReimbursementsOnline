import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount,
  safeAmount,
  detectCurrency,
  excelMoneyFormat,
} from "../src/util/money.ts";

test("parseAmount: US formatting", () => {
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount("12.00"), 12);
  assert.equal(parseAmount("USD 7.5"), 7.5);
  assert.equal(parseAmount("$0.99"), 0.99);
  assert.equal(parseAmount("1,000"), 1000);
});

test("parseAmount: European formatting", () => {
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("12,00"), 12);
  assert.equal(parseAmount("€ 9,99"), 9.99);
});

test("parseAmount: rejects junk and absurd values", () => {
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount("9999999999"), null); // > 1,000,000 guard
});

test("safeAmount clamps non-finite and negative", () => {
  assert.equal(safeAmount(Number.NaN), 0);
  assert.equal(safeAmount(Infinity), 0);
  assert.equal(safeAmount(-5), 0);
  assert.equal(safeAmount(10.005), 10.01);
});

test("detectCurrency from symbol or code", () => {
  assert.equal(detectCurrency("Total £10.00"), "GBP");
  assert.equal(detectCurrency("EUR 5.00"), "EUR");
  assert.equal(detectCurrency("plain 5.00", "CAD"), "CAD");
});

test("excelMoneyFormat picks a symbol", () => {
  assert.equal(excelMoneyFormat("USD"), "$#,##0.00");
  assert.equal(excelMoneyFormat("EUR"), "€#,##0.00");
});
