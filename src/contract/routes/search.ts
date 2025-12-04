import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { SearchInputSchema, SearchResultSchema } from "../schemas/search";

export const searchRoutes = {
  search: oc
    .route({ method: "POST", path: "/search" })
    .input(
      SearchInputSchema.describe("Search forum content by text, filters, and pagination")
    )
    .output(
      SearchResultSchema.describe("Posts/topics/users/tags returned for the search query")
    )
    .errors(CommonPluginErrors),
};
