import { Octokit } from '@octokit/action';
import type { RawComment } from './model.js';

export type ReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes';

export interface IssueRef {
  number: number;
  title: string;
  body: string | null;
}

export interface GitHubApi {
  findTrackerIssue(label: string): Promise<IssueRef | null>;
  createIssue(params: { title: string; body: string; labels: string[] }): Promise<number>;
  updateIssueBody(issueNumber: number, body: string): Promise<void>;
  listComments(issueNumber: number): Promise<RawComment[]>;
  reactToComment(commentId: number, content: ReactionContent): Promise<void>;
  addComment(issueNumber: number, body: string): Promise<void>;
  listPullRequestFiles(prNumber: number): Promise<string[]>;
}

export function createGitHubApi(token: string, repo: { owner: string; repo: string }): GitHubApi {
  const octokit = new Octokit({ auth: token });
  const { owner, repo: repoName } = repo;

  return {
    async findTrackerIssue(label) {
      const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
        owner,
        repo: repoName,
        labels: label,
        state: 'open',
        per_page: 100,
      });
      const first = issues[0];
      return first ? { number: first.number, title: first.title, body: first.body ?? null } : null;
    },
    async createIssue({ title, body, labels }) {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo: repoName,
        title,
        body,
        labels,
      });
      return data.number;
    },
    async updateIssueBody(issueNumber, body) {
      await octokit.rest.issues.update({ owner, repo: repoName, issue_number: issueNumber, body });
    },
    async listComments(issueNumber) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo: repoName,
        issue_number: issueNumber,
        per_page: 100,
      });
      return comments.map((comment) => ({
        id: comment.id,
        user: comment.user?.login ?? '',
        createdAt: comment.created_at,
        htmlUrl: comment.html_url,
        body: comment.body ?? '',
      }));
    },
    async reactToComment(commentId, content) {
      await octokit.rest.reactions
        .createForIssueComment({ owner, repo: repoName, comment_id: commentId, content })
        .catch((error: unknown) => {
          // 422 = 已存在同款 reaction；404 = 评论已删除，均视为幂等成功
          if (
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            ((error as { status?: number }).status === 422 ||
              (error as { status?: number }).status === 404)
          ) {
            return;
          }
          throw error;
        });
    },
    async addComment(issueNumber, body) {
      await octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        body,
      });
    },
    async listPullRequestFiles(prNumber) {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
      });
      return files.map((file) => file.filename);
    },
  };
}
