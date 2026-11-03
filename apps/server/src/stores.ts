/** The participant side of the store key service (docs/security.md#store-keys). */
import type { Config } from './config.ts';
import { empty, HttpError, json, jsonBody, noStore, optStr, type Reply, type Request, str } from './http.ts';
import { KeyFailure, type KeyService } from './keys.ts';
import { checkParticipant, loadProject } from './projects.ts';

function keyError(e: unknown): never {
  if (!(e instanceof KeyFailure)) throw e;
  const err = e.error;
  switch (err.kind) {
    case 'invalid_password':
      throw new HttpError(400, 'invalid_password');
    case 'not_found':
      throw new HttpError(404, 'no_such_store');
    case 'invalid_reset_token':
      throw new HttpError(403, 'invalid_reset_token');
    case 'wrong_password':
      throw new HttpError(401, 'wrong_password', err.retryAfter);
    case 'too_many_attempts':
      throw new HttpError(429, 'too_many_attempts', err.retryAfter);
  }
}

export function projectError(e: 'not_found' | 'invalid' | 'io'): HttpError {
  if (e === 'not_found') return new HttpError(404, 'no_such_project');
  return new HttpError(500, e === 'invalid' ? 'invalid_config' : 'io');
}

export function storeHandlers(config: Config, keys: KeyService) {
  const guard = async (work: () => Promise<Reply> | Reply): Promise<Reply> => {
    try {
      return await work();
    } catch (e) {
      return keyError(e);
    }
  };
  return {
    create: async (req: Request): Promise<Reply> => {
      const body = jsonBody(req);
      const projectId = str(body, 'project');
      const participantId = optStr(body, 'participant_id');
      const password = str(body, 'password');
      const project = await loadProject(config.dataDir, projectId);
      if (typeof project !== 'object') throw projectError(project);
      const participant = checkParticipant(project, participantId);
      if (participant === 'required') throw new HttpError(400, 'participant_required');
      if (participant === 'invalid') throw new HttpError(400, 'invalid_participant');
      return noStore(
        await guard(async () => {
          const store = await keys.create(req.ip, projectId, participant, password);
          return json({ store_id: store.storeId, kek: store.kek, delete_token: store.deleteToken }, 201);
        }),
      );
    },
    unlock: async (req: Request): Promise<Reply> => {
      const password = str(jsonBody(req), 'password');
      return noStore(await guard(async () => json({ kek: await keys.unlock(req.ip, req.params.id, password) })));
    },
    reset: async (req: Request): Promise<Reply> => {
      const body = jsonBody(req);
      const token = str(body, 'token');
      const password = str(body, 'password');
      return noStore(await guard(async () => json({ kek: await keys.reset(req.ip, req.params.id, token, password) })));
    },
    delete: async (req: Request): Promise<Reply> => {
      const token = str(jsonBody(req), 'delete_token');
      return guard(() => {
        keys.delete(req.ip, req.params.id, token);
        return empty(204);
      });
    },
  };
}
