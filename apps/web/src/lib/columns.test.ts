import { describe, expect, it } from "vitest";
import { fitColumns } from "./columns";

const cols = [
  { label: "Name", width: 300 },
  { label: "What" },
  { label: "Status", width: 180 },
  { label: "Landed", width: 100, drop: 2 },
  { label: "In flight", width: 100, drop: 1 },
  { label: "Spent", width: 110 },
];

describe("fitColumns", () => {
  const labels = (w: number) => fitColumns(cols, w).shown.map((c) => c.label);

  it("keeps every column while they fit", () => {
    expect(labels(1030)).toEqual(["Name", "What", "Status", "Landed", "In flight", "Spent"]);
  });

  it("drops columns in their drop order, one at a time, only as far as it takes", () => {
    expect(labels(1029)).toEqual(["Name", "What", "Status", "Landed", "Spent"]);
    expect(labels(929)).toEqual(["Name", "What", "Status", "Spent"]);
  });

  it("keeps the columns without a drop order, and asks for cards once they do not fit", () => {
    expect(fitColumns(cols, 830)).toMatchObject({ cards: false });
    expect(labels(500)).toEqual(["Name", "What", "Status", "Spent"]);
    expect(fitColumns(cols, 829)).toMatchObject({ cards: true });
  });
});
