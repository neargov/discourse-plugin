import { z } from "every-plugin/zod";
import type { SiteBasicInfo } from "../contract";
import type { ResourceClient } from "../client";
import { runWithContext } from "../client";
import { parseWithSchemaOrThrow } from "./shared";
import { mapCategory } from "./categories";

export const RawSiteDetailsSchema = z
  .preprocess((value) => (value && typeof value === "object" ? value : {}), z.object({
    title: z.string().default(""),
    description: z.string().nullable().default(null),
    logo_url: z.string().nullable().default(null),
    mobile_logo_url: z.string().nullable().default(null),
    favicon_url: z.string().nullable().default(null),
    contact_email: z.string().nullable().default(null),
    canonical_hostname: z.string().nullable().default(null),
    default_locale: z.string().nullable().default(null),
  }));

export const mapSiteDetails = (site: any): SiteBasicInfo => {
  const parsed = parseWithSchemaOrThrow(
    RawSiteDetailsSchema,
    site,
    "Site info",
    "Malformed site info response"
  );

  return {
    title: parsed.title,
    description: parsed.description,
    logoUrl: parsed.logo_url,
    mobileLogoUrl: parsed.mobile_logo_url,
    faviconUrl: parsed.favicon_url,
    contactEmail: parsed.contact_email,
    canonicalHostname: parsed.canonical_hostname,
    defaultLocale: parsed.default_locale,
  };
};

type SiteBasicInfoResponse = { site?: any; categories?: any[] } & Record<string, unknown>;
type SiteInfoResponse = { site?: any; categories?: any[] } & Record<string, unknown>;

export const createSiteResource = (client: ResourceClient) => ({
  getSiteInfo: () =>
    runWithContext("Get site info", async () => {
      const data = await client.fetchApi<SiteInfoResponse>("/site.json");
      if (!data) {
        throw new Error("Empty site info response");
      }

      const siteSource = data.site ?? data;
      /* c8 ignore start */
      const categoriesSource =
        Array.isArray(data.categories) || data.categories == null
          ? data.categories
          : Array.isArray((siteSource as any)?.categories)
            ? (siteSource as any).categories
            : null;

      if (categoriesSource !== null && categoriesSource !== undefined && !Array.isArray(categoriesSource)) {
        throw new Error("Malformed site categories response");
      }
      /* c8 ignore stop */

      const categories = (categoriesSource ?? []).map((cat: any) => mapCategory(cat));

      return {
        ...mapSiteDetails(siteSource),
        categories,
      };
    }),

  getSiteBasicInfo: () =>
    runWithContext("Get site basic info", async () => {
      const data = await client.fetchApi<SiteBasicInfoResponse>("/site/basic-info.json");
      const siteSource = data?.site ?? data;
      if (!siteSource) {
        throw new Error("Empty site basic info response");
      }

      return mapSiteDetails(siteSource);
    }),
});

export type SiteResource = ReturnType<typeof createSiteResource>;
