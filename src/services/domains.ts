import type { ResourceClient } from "../client";
import {
  createUploadsResource,
  type UploadsResource,
} from "../resources/uploads";
import {
  createTagsResource,
  type TagsResource,
} from "../resources/tags";
import {
  createCategoriesResource,
  type CategoriesResource,
} from "../resources/categories";
import {
  createTopicsResource,
  type TopicsResource,
} from "../resources/topics";
import {
  createPostsResource,
  type PostsResource,
} from "../resources/posts";
import {
  createUsersResource,
  type UsersResource,
} from "../resources/users";
import {
  createSearchResource,
  type SearchResource,
} from "../resources/search";
import {
  createSiteResource,
  type SiteResource,
} from "../resources/site";

export type UploadsService = UploadsResource;
export type TagsService = TagsResource;
export type CategoriesService = CategoriesResource;
export type TopicsService = TopicsResource;
export type PostsService = PostsResource;
export type UsersService = UsersResource;
export type SearchService = SearchResource;
export type SiteService = SiteResource;

export type DomainFactories = {
  uploads: (client: ResourceClient) => UploadsService;
  tags: (client: ResourceClient) => TagsService;
  categories: (client: ResourceClient) => CategoriesService;
  topics: (client: ResourceClient) => TopicsService;
  posts: (client: ResourceClient) => PostsService;
  users: (client: ResourceClient) => UsersService;
  search: (client: ResourceClient) => SearchService;
  site: (client: ResourceClient) => SiteService;
};

export const createUploadsService: DomainFactories["uploads"] = (client) =>
  createUploadsResource(client);

export const createTagsService: DomainFactories["tags"] = (client) =>
  createTagsResource(client);

export const createCategoriesService: DomainFactories["categories"] = (client) =>
  createCategoriesResource(client);

export const createTopicsService: DomainFactories["topics"] = (client) =>
  createTopicsResource(client);

export const createPostsService: DomainFactories["posts"] = (client) =>
  createPostsResource(client);

export const createUsersService: DomainFactories["users"] = (client) =>
  createUsersResource(client);

export const createSearchService: DomainFactories["search"] = (client) =>
  createSearchResource(client);

export const createSiteService: DomainFactories["site"] = (client) =>
  createSiteResource(client);

const defaultDomainFactories: DomainFactories = {
  uploads: createUploadsService,
  tags: createTagsService,
  categories: createCategoriesService,
  topics: createTopicsService,
  posts: createPostsService,
  users: createUsersService,
  search: createSearchService,
  site: createSiteService,
};

export type DomainServices = {
  uploads: UploadsService;
  tags: TagsService;
  categories: CategoriesService;
  topics: TopicsService;
  posts: PostsService;
  users: UsersService;
  search: SearchService;
  site: SiteService;
};

export const createDomainServices = (
  client: ResourceClient,
  overrides: Partial<DomainFactories> = {}
): DomainServices => {
  const factories: DomainFactories = {
    ...defaultDomainFactories,
    ...overrides,
  };

  return {
    uploads: factories.uploads(client),
    tags: factories.tags(client),
    categories: factories.categories(client),
    topics: factories.topics(client),
    posts: factories.posts(client),
    users: factories.users(client),
    search: factories.search(client),
    site: factories.site(client),
  };
};
