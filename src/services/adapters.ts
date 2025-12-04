import type {
  CategoriesService,
  DomainServices,
  PostsService,
  SearchService,
  SiteService,
  TagsService,
  TopicsService,
  UploadsService,
  UsersService,
} from "./domains";

export type UploadsServiceAdapter = Pick<
  UploadsService,
  | "buildUploadRequest"
  | "presignUpload"
  | "batchPresignMultipartUpload"
  | "completeMultipartUpload"
  | "abortMultipartUpload"
>;

export type TagsServiceAdapter = Pick<
  TagsService,
  | "getTags"
  | "getTag"
  | "getTagGroups"
  | "getTagGroup"
  | "createTagGroup"
  | "updateTagGroup"
>;

export type CategoriesServiceAdapter = Pick<
  CategoriesService,
  "getCategories" | "getCategory"
>;

export type TopicsServiceAdapter = Pick<
  TopicsService,
  | "getTopic"
  | "getLatestTopics"
  | "getTopTopics"
  | "getTopicList"
  | "getCategoryTopics"
  | "updateTopicStatus"
  | "updateTopicMetadata"
  | "bookmarkTopic"
  | "inviteToTopic"
  | "setTopicNotification"
  | "changeTopicTimestamp"
  | "addTopicTimer"
>;

export type PostsServiceAdapter = Pick<
  PostsService,
  | "createPost"
  | "getPost"
  | "getPostReplies"
  | "listPosts"
  | "editPost"
  | "lockPost"
  | "performPostAction"
  | "deletePost"
  | "getRevision"
  | "updateRevision"
  | "deleteRevision"
>;

export type UsersServiceAdapter = Pick<
  UsersService,
  | "getCurrentUser"
  | "getUser"
  | "createUser"
  | "updateUser"
  | "deleteUser"
  | "listUsers"
  | "listAdminUsers"
  | "getUserByExternal"
  | "getDirectory"
  | "forgotPassword"
  | "changePassword"
  | "logoutUser"
  | "syncSso"
  | "getUserStatus"
  | "updateUserStatus"
  | "validateUserApiKey"
>;

export type SearchServiceAdapter = Pick<SearchService, "search">;

export type SiteServiceAdapter = Pick<SiteService, "getSiteInfo" | "getSiteBasicInfo">;

export type DomainMethodAdapters = UploadsServiceAdapter &
  TagsServiceAdapter &
  CategoriesServiceAdapter &
  TopicsServiceAdapter &
  PostsServiceAdapter &
  UsersServiceAdapter &
  SearchServiceAdapter &
  SiteServiceAdapter;

const createUploadsAdapter = (uploads: UploadsService): UploadsServiceAdapter => ({
  buildUploadRequest: uploads.buildUploadRequest,
  presignUpload: uploads.presignUpload,
  batchPresignMultipartUpload: uploads.batchPresignMultipartUpload,
  completeMultipartUpload: uploads.completeMultipartUpload,
  abortMultipartUpload: uploads.abortMultipartUpload,
});

const createTagsAdapter = (tags: TagsService): TagsServiceAdapter => ({
  getTags: tags.getTags,
  getTag: tags.getTag,
  getTagGroups: tags.getTagGroups,
  getTagGroup: tags.getTagGroup,
  createTagGroup: tags.createTagGroup,
  updateTagGroup: tags.updateTagGroup,
});

const createCategoriesAdapter = (
  categories: CategoriesService
): CategoriesServiceAdapter => ({
  getCategories: categories.getCategories,
  getCategory: categories.getCategory,
});

const createTopicsAdapter = (topics: TopicsService): TopicsServiceAdapter => ({
  getTopic: topics.getTopic,
  getLatestTopics: topics.getLatestTopics,
  getTopTopics: topics.getTopTopics,
  getTopicList: topics.getTopicList,
  getCategoryTopics: topics.getCategoryTopics,
  updateTopicStatus: topics.updateTopicStatus,
  updateTopicMetadata: topics.updateTopicMetadata,
  bookmarkTopic: topics.bookmarkTopic,
  inviteToTopic: topics.inviteToTopic,
  setTopicNotification: topics.setTopicNotification,
  changeTopicTimestamp: topics.changeTopicTimestamp,
  addTopicTimer: topics.addTopicTimer,
});

const createPostsAdapter = (posts: PostsService): PostsServiceAdapter => ({
  createPost: posts.createPost,
  getPost: posts.getPost,
  getPostReplies: posts.getPostReplies,
  listPosts: posts.listPosts,
  editPost: posts.editPost,
  lockPost: posts.lockPost,
  performPostAction: posts.performPostAction,
  deletePost: posts.deletePost,
  getRevision: posts.getRevision,
  updateRevision: posts.updateRevision,
  deleteRevision: posts.deleteRevision,
});

const createUsersAdapter = (users: UsersService): UsersServiceAdapter => ({
  getCurrentUser: users.getCurrentUser,
  getUser: users.getUser,
  createUser: users.createUser,
  updateUser: users.updateUser,
  deleteUser: users.deleteUser,
  listUsers: users.listUsers,
  listAdminUsers: users.listAdminUsers,
  getUserByExternal: users.getUserByExternal,
  getDirectory: users.getDirectory,
  forgotPassword: users.forgotPassword,
  changePassword: users.changePassword,
  logoutUser: users.logoutUser,
  syncSso: users.syncSso,
  getUserStatus: users.getUserStatus,
  updateUserStatus: users.updateUserStatus,
  validateUserApiKey: users.validateUserApiKey,
});

const createSearchAdapter = (search: SearchService): SearchServiceAdapter => ({
  search: search.search,
});

const createSiteAdapter = (site: SiteService): SiteServiceAdapter => ({
  getSiteInfo: site.getSiteInfo,
  getSiteBasicInfo: site.getSiteBasicInfo,
});

export const createDomainMethodAdapters = (
  services: DomainServices
): DomainMethodAdapters => ({
  ...createUploadsAdapter(services.uploads),
  ...createTagsAdapter(services.tags),
  ...createCategoriesAdapter(services.categories),
  ...createTopicsAdapter(services.topics),
  ...createPostsAdapter(services.posts),
  ...createUsersAdapter(services.users),
  ...createSearchAdapter(services.search),
  ...createSiteAdapter(services.site),
});
