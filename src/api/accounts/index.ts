import { Router } from 'express';
import db from '../../db';
import { authValidator, IDValidator } from '../middlewares';

const router = Router();

router.get('/', authValidator, async (_req, res, next) => {
  try {
    res.json({
      accounts: await db.selectFrom('account').selectAll().execute(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authValidator, IDValidator, async (req, res, next) => {
  try {
    res.json({
      account: await db.selectFrom('account')
        .selectAll()
        .where('id', '=', Number(req.params.id))
        .executeTakeFirstOrThrow(),
    });
  } catch (error) {
    res.status(404);
    next(error);
  }
});

export default router;
