import { describe, expect, it } from 'vitest';
import { forecastDurability, forecastHealth } from '../src/ui/tactical-panel.ts';

describe('combat forecast display units', () => {
  it('converts percentage damage to HP while preserving fractional health', () => {
    expect(forecastHealth(10, 55)).toBe(4.5);
    expect(forecastHealth(7.2, 13)).toBeCloseTo(5.9);
  });

  it('shows zero HP after overkill and never heals from a negative damage sentinel', () => {
    expect(forecastHealth(3, 85)).toBe(0);
    expect(forecastHealth(6.5, -1)).toBe(6.5);
    expect(forecastHealth(12, 0)).toBe(10);
  });

  it('keeps environmental durability in its raw scale instead of dividing by ten', () => {
    expect(forecastDurability(99, 55)).toBe(44);
    expect(forecastDurability(30, 55)).toBe(0);
    expect(forecastDurability(99, -1)).toBe(99);
  });
});
