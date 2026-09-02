import { tool } from "@nylorun/harness";
import { z } from "zod";

const units = [
  "celsius",
  "fahrenheit",
  "kelvin",
  "meter",
  "kilometer",
  "foot",
  "mile",
] as const;

type Unit = (typeof units)[number];

const dimension: Record<Unit, "temperature" | "length"> = {
  celsius: "temperature",
  fahrenheit: "temperature",
  kelvin: "temperature",
  meter: "length",
  kilometer: "length",
  foot: "length",
  mile: "length",
};

export const tools = [
  tool({
    name: "convert",
    description:
      "Convert a number between celsius, fahrenheit, kelvin, meter, kilometer, foot, and mile. Use after calculate when the result needs a different unit.",
    parameters: z.object({
      value: z.number(),
      from: z.enum(units),
      to: z.enum(units),
    }),
    async execute({ value, from, to }) {
      if (dimension[from] !== dimension[to]) {
        return {
          kind: "failed" as const,
          code: "convert.incompatible",
          message: `Cannot convert ${from} to ${to}.`,
        };
      }
      return {
        kind: "completed" as const,
        output: { value, from, to, result: round(convertValue(value, from, to)) },
      };
    },
  }),
];

function convertValue(value: number, from: Unit, to: Unit): number {
  if (from === to) return value;
  if (dimension[from] === "temperature") {
    return fromKelvin(toKelvin(value, from), to);
  }
  return fromMeters(toMeters(value, from), to);
}

function toKelvin(value: number, from: Unit): number {
  if (from === "celsius") return value + 273.15;
  if (from === "fahrenheit") return ((value - 32) * 5) / 9 + 273.15;
  return value;
}

function fromKelvin(value: number, to: Unit): number {
  if (to === "celsius") return value - 273.15;
  if (to === "fahrenheit") return ((value - 273.15) * 9) / 5 + 32;
  return value;
}

function toMeters(value: number, from: Unit): number {
  if (from === "kilometer") return value * 1_000;
  if (from === "foot") return value * 0.3048;
  if (from === "mile") return value * 1_609.344;
  return value;
}

function fromMeters(value: number, to: Unit): number {
  if (to === "kilometer") return value / 1_000;
  if (to === "foot") return value / 0.3048;
  if (to === "mile") return value / 1_609.344;
  return value;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
