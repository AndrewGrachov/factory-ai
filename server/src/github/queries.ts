// Per-page cost is superlinear in the nested connections: asking for 100 union-typed
// timeline nodes per PR made 25 PRs/page time out (504), while counts-only versions of
// the same events keep a 25-PR page at ~5s. When a page times out, shrink the *nested*
// selections before the page size.
export const PAGE_SIZE = 25;
export const INNER_LIMIT = 100;

/**
 * Full walks order by CREATED_AT DESC — the ordering `stats.meta.window` was written against.
 * Incremental walks order by UPDATED_AT DESC so they can stop as soon as a page falls entirely
 * below the watermark; the store re-imposes creation order on load, so nothing downstream sees
 * the difference.
 */
export const CREATED_DESC = { field: 'CREATED_AT', direction: 'DESC' } as const;
export const UPDATED_DESC = { field: 'UPDATED_AT', direction: 'DESC' } as const;

export const PR_QUERY = `
query($owner: String!, $name: String!, $pageSize: Int!, $cursor: String, $order: IssueOrder!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED, OPEN, CLOSED], first: $pageSize, after: $cursor,
                 orderBy: $order) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        isDraft
        baseRefName
        headRefName
        createdAt
        updatedAt
        mergedAt
        closedAt
        additions
        deletions
        changedFiles
        author { login }
        commits(first: ${INNER_LIMIT}) {
          totalCount
          nodes { commit { oid committedDate } }
        }
        comments(first: 0) { totalCount }
        labels(first: 20) { nodes { name } }
        reviews(first: ${INNER_LIMIT}) {
          totalCount
          nodes { id author { login } state submittedAt }
        }
        reviewThreads(first: ${INNER_LIMIT}) {
          totalCount
          nodes {
            id
            isResolved
            isOutdated
            comments(first: 1) {
              nodes { author { login } createdAt pullRequestReview { id } }
            }
          }
        }
        # timelineItems.totalCount ignores itemTypes and reports the whole timeline —
        # it once claimed 404 force pushes across 14 PRs. The nodes list does respect
        # the filter, so force pushes have to be counted from the filtered nodes.
        forcePushes: timelineItems(first: 50, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes { __typename }
        }
        readyForReview: timelineItems(first: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) {
          nodes { ... on ReadyForReviewEvent { createdAt } }
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

// `since` is mandatory: dev carries ~27k commits of pre-existing history, which
// would be 270 pages for a number that only describes the last few months.
export const HISTORY_QUERY = `
query($owner: String!, $name: String!, $branch: String!, $since: GitTimestamp!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $branch) {
      target {
        ... on Commit {
          history(first: 100, after: $cursor, since: $since) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { oid messageHeadline committedDate }
          }
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

// Connections whose node lists feed distributions rather than totals. A PR that
// exceeds the page limit (real case: #149 with 397 reviews and 195 threads) needs a
// second pass, or the resolution ratio quietly undercounts. totalCount stays exact.
export const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${INNER_LIMIT}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 1) {
            nodes { author { login } createdAt pullRequestReview { id } }
          }
        }
      }
    }
  }
}`;

export const REVIEWS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: ${INNER_LIMIT}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id author { login } state submittedAt }
      }
    }
  }
}`;
