import { z } from "every-plugin/zod";
import { CategorySchema } from "./categories";

export const SiteBasicInfoSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  logoUrl: z.string().nullable(),
  mobileLogoUrl: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  contactEmail: z.string().nullable(),
  canonicalHostname: z.string().nullable(),
  defaultLocale: z.string().nullable(),
});

export const SiteInfoSchema = SiteBasicInfoSchema.extend({
  categories: z.array(CategorySchema),
});
