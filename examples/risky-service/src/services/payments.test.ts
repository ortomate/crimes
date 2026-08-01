import { describe, it, expect, vi } from "vitest";
import { submitPayment } from "./payments.js";
import { api } from "../lib/api.js";
import { stripe } from "../lib/stripe.js";

vi.mock("../lib/api.js", () => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("../lib/stripe.js", () => ({ refunds: vi.fn(), charges: vi.fn() }));

describe("submitPayment", () => {
  it("posts the charge", async () => {
    await submitPayment({ total: 100 });
    expect(api.post).toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith("/charges", expect.anything());
  });
});
