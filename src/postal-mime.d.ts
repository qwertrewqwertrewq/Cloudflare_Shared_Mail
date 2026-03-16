declare module "postal-mime" {
  export default class PostalMime {
    parse(input: ArrayBuffer): Promise<{
      subject?: string;
      from?: { address?: string };
      to?: Array<{ address?: string }>;
      text?: string;
      html?: string;
      date?: string;
      headers?: Record<string, unknown>;
    }>;
  }
}
