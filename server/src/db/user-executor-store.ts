import type { Sql } from 'postgres';

export interface UserExecutor {
    readonly name: string;
    readonly type: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface UserExecutorStore {
    /**
     * Replaces a member's whole executor list.
     *
     * The body of `PUT /api/workspace/executors` is the entire list, so this is delete-then-insert:
     * replaying the same body changes nothing, which is what makes the route a PUT. Unlike
     * user_repo there is nothing to preserve — a row tracks no disk state, so "keeping" an omitted
     * executor would only contradict the body the member just sent.
     */
    replace(userId: string, executors: readonly { name: string; type: string; config: Record<string, unknown> }[]): Promise<void>;
    list(userId: string): Promise<UserExecutor[]>;
}

interface Row {
    name: string;
    type: string;
    created_at: Date;
    updated_at: Date;
}

const toUserExecutor = (row: Row): UserExecutor => ({
    name: row.name,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

/** The organization is bound at construction, for the reason createUserRepoStore's header gives. */
export function createUserExecutorStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): UserExecutorStore {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async replace(userId, executors) {
            await gate();
            await sql.begin(async (tx) => {
                await tx`
                    delete from user_executor
                    where org_id = ${orgId} and user_id = ${userId}
                `;
                if (executors.length) {
                    const rows = executors.map((executor) => ({
                        org_id: orgId,
                        user_id: userId,
                        name: executor.name,
                        type: executor.type,
                        config: executor.config as never,
                    }));
                    await tx`
                        insert into user_executor ${tx(rows, 'org_id', 'user_id', 'name', 'type', 'config')}
                    `;
                }
            });
        },

        async list(userId) {
            await gate();
            // `config` is deliberately not selected: the routes echo these rows on every poll, and
            // pasted config may hold credentials.
            const rows = await sql<Row[]>`
                select name, type, created_at, updated_at
                from user_executor
                where org_id = ${orgId} and user_id = ${userId}
                order by created_at asc, name asc
            `;
            return rows.map(toUserExecutor);
        },
    };
}
