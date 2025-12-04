import { describe, expect, it, vi } from "vitest";
import {
  DiscourseService,
  noopLogger,
  type DomainFactories,
} from "../../service";

const baseUrl = "https://example.com";
const systemApiKey = "api-key";
const systemUsername = "system";

const buildService = (overrides: Partial<DomainFactories>) =>
  new DiscourseService(baseUrl, systemApiKey, systemUsername, noopLogger, {
    domainFactories: overrides,
  });

describe("DiscourseService domain delegation", () => {
  it("delegates uploads operations to uploads service", () => {
    const uploads = {
      buildUploadRequest: vi.fn().mockReturnValue({ request: true }),
      presignUpload: vi.fn().mockReturnValue({ presigned: true }),
      batchPresignMultipartUpload: vi.fn().mockReturnValue({ batch: true }),
      completeMultipartUpload: vi.fn().mockReturnValue({ done: true }),
      abortMultipartUpload: vi.fn().mockReturnValue(true),
    };

    const service = buildService({ uploads: () => uploads as any });
    const requestParams = { uploadType: "image" };
    const presignParams = { filename: "file", byteSize: 10 };

    expect(service.buildUploadRequest(requestParams)).toEqual({ request: true });
    expect(uploads.buildUploadRequest).toHaveBeenCalledWith(requestParams);

    service.presignUpload(presignParams as any);
    expect(uploads.presignUpload).toHaveBeenCalledWith(presignParams);

    const batchParams = { uniqueIdentifier: "u1", partNumbers: [1, 2] };
    service.batchPresignMultipartUpload(batchParams as any);
    expect(uploads.batchPresignMultipartUpload).toHaveBeenCalledWith(batchParams);

    const completeParams = { uploadId: "u", key: "k", parts: [], uniqueIdentifier: "u1", filename: "file" };
    service.completeMultipartUpload(completeParams as any);
    expect(uploads.completeMultipartUpload).toHaveBeenCalledWith(completeParams);

    const abortParams = { uniqueIdentifier: "u1", uploadId: "u", key: "k" };
    service.abortMultipartUpload(abortParams as any);
    expect(uploads.abortMultipartUpload).toHaveBeenCalledWith(abortParams);
  });

  it("delegates tag operations to tags service", () => {
    const tags = {
      getTags: vi.fn().mockReturnValue(["a"]),
      getTag: vi.fn().mockReturnValue("tag"),
      getTagGroups: vi.fn(),
      getTagGroup: vi.fn(),
      createTagGroup: vi.fn(),
      updateTagGroup: vi.fn(),
    };

    const service = buildService({ tags: () => tags as any });
    expect(service.getTags()).toEqual(["a"]);
    expect(tags.getTags).toHaveBeenCalled();

    service.getTag("news");
    expect(tags.getTag).toHaveBeenCalledWith("news");

    service.getTagGroups();
    expect(tags.getTagGroups).toHaveBeenCalled();

    service.getTagGroup(4);
    expect(tags.getTagGroup).toHaveBeenCalledWith(4);

    const createParams = { name: "group" };
    service.createTagGroup(createParams as any);
    expect(tags.createTagGroup).toHaveBeenCalledWith(createParams);

    const updateParams = { tagGroupId: 2, name: "new" };
    service.updateTagGroup(updateParams as any);
    expect(tags.updateTagGroup).toHaveBeenCalledWith(updateParams);
  });

  it("delegates category operations to categories service", () => {
    const categories = {
      getCategories: vi.fn().mockReturnValue(["cat"]),
      getCategory: vi.fn(),
    };

    const service = buildService({ categories: () => categories as any });
    expect(service.getCategories()).toEqual(["cat"]);
    expect(categories.getCategories).toHaveBeenCalled();

    service.getCategory("general");
    expect(categories.getCategory).toHaveBeenCalledWith("general");
  });

  it("delegates topic operations to topics service", () => {
    const topics = {
      getTopic: vi.fn().mockReturnValue({ id: 1 }),
      getTopicList: vi.fn(),
      bookmarkTopic: vi.fn(),
      addTopicTimer: vi.fn(),
    };

    const service = buildService({ topics: () => topics as any });
    expect(service.getTopic(1)).toEqual({ id: 1 });
    expect(topics.getTopic).toHaveBeenCalledWith(1);

    const listParams = { type: "latest" as const, page: 1 };
    service.getTopicList(listParams);
    expect(topics.getTopicList).toHaveBeenCalledWith(listParams);

    const bookmarkParams = { topicId: 2, postNumber: 1, username: "jane" };
    service.bookmarkTopic(bookmarkParams as any);
    expect(topics.bookmarkTopic).toHaveBeenCalledWith(bookmarkParams);

    const timerParams = { topicId: 3, statusType: "close" };
    service.addTopicTimer(timerParams as any);
    expect(topics.addTopicTimer).toHaveBeenCalledWith(timerParams);
  });

  it("delegates post operations to posts service", () => {
    const posts = {
      createPost: vi.fn().mockReturnValue({ id: 1 }),
      getPost: vi.fn(),
      performPostAction: vi.fn(),
    };

    const service = buildService({ posts: () => posts as any });
    const createParams = { raw: "hello world", username: "sam" };
    expect(service.createPost(createParams as any)).toEqual({ id: 1 });
    expect(posts.createPost).toHaveBeenCalledWith(createParams);

    service.getPost(9, true);
    expect(posts.getPost).toHaveBeenCalledWith(9, true);

    const actionParams = { postId: 1, action: "like", username: "sam" };
    service.performPostAction(actionParams as any);
    expect(posts.performPostAction).toHaveBeenCalledWith(actionParams);
  });

  it("delegates user operations to users service", () => {
    const users = {
      getUser: vi.fn().mockReturnValue({ id: 10 }),
      validateUserApiKey: vi.fn(),
      changePassword: vi.fn(),
    };

    const service = buildService({ users: () => users as any });
    expect(service.getUser("jane")).toEqual({ id: 10 });
    expect(users.getUser).toHaveBeenCalledWith("jane");

    service.validateUserApiKey("token");
    expect(users.validateUserApiKey).toHaveBeenCalledWith("token");

    const changeParams = { token: "t", password: "secret" };
    service.changePassword(changeParams);
    expect(users.changePassword).toHaveBeenCalledWith(changeParams);
  });

  it("delegates search operations to search service", () => {
    const search = { search: vi.fn().mockReturnValue({ hits: [] }) };
    const service = buildService({ search: () => search as any });
    const params = { query: "text" };
    expect(service.search(params as any)).toEqual({ hits: [] });
    expect(search.search).toHaveBeenCalledWith(params);
  });

  it("delegates site operations to site service", () => {
    const site = {
      getSiteInfo: vi.fn().mockReturnValue({ title: "Site" }),
      getSiteBasicInfo: vi.fn(),
    };

    const service = buildService({ site: () => site as any });
    expect(service.getSiteInfo()).toEqual({ title: "Site" });
    expect(site.getSiteInfo).toHaveBeenCalled();

    service.getSiteBasicInfo();
    expect(site.getSiteBasicInfo).toHaveBeenCalled();
  });
});
