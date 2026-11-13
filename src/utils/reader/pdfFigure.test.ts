import { afterEach, expect, jest, test } from "@jest/globals";
import { originalPdfFigure } from "./pdfFigure";

afterEach(() => {
  jest.restoreAllMocks();
});

test("copies the exact native figure pixels independently of CSS display width", () => {
  const source = document.createElement("canvas");
  source.width = 1600;
  source.height = 2200;
  const drawImage = jest.fn();
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as any);

  const figure = originalPdfFigure(source, [40.2, 100.4, 280.1, 340.2], 400, 220, "原图")!;

  expect([figure.width, figure.height]).toEqual([961, 960]);
  expect(drawImage).toHaveBeenCalledWith(source, 160, 401, 961, 960, 0, 0, 961, 960);
  expect(figure.style.width).toBe("220px");
  expect(figure.getAttribute("aria-label")).toBe("原图");
});
