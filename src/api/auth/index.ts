import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { NoResultError } from 'kysely';

import db from '../../db';
import { AccountSchema } from '../../schemas';
import { getAuthValidator, loginValidator, signupValidator } from '../middlewares';
import { generateJWT, saltRounds } from './utils';

const router = Router();

router.post(
  '/signup',
  signupValidator,
  async (req: Request<{}, {}, Omit<AccountSchema, 'id'>>, res: Response, next) => {
    try {
      const duplicateAccount = await db.selectFrom('account').selectAll()
        .where('email', '=', req.body.email)
        .orWhere('username', '=', req.body.username)
        .executeTakeFirst();

      if (duplicateAccount) {
        res.status(400);
        throw new Error((duplicateAccount.email === req.body.email)
          ? 'This account already exists, please login'
          : 'This username is unavailable');
      }

      const { password, ...account } = await db.insertInto('account').values({
        ...req.body,
        password: await bcrypt.hash(req.body.password, saltRounds),
      }).returningAll().executeTakeFirstOrThrow();

      res.json({
        account,
        token: generateJWT(account.id),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post('/login', loginValidator, async (req: Request<{}, {}, Pick<AccountSchema, 'email' | 'password'>>, res: Response, next) => {
  try {
    const { password, ...account } = await db.selectFrom('account').selectAll()
      .where('email', '=', req.body.email).executeTakeFirstOrThrow();

    if (!await bcrypt.compare(req.body.password, password)) {
      throw new EvalError();
    }

    res.json({
      account,
      token: generateJWT(account.id),
    });
  } catch (error) {
    if (error instanceof NoResultError || error instanceof EvalError) {
      res.status(400);
      next(new Error('Invalid credentials'));
    } else {
      next(error);
    }
  }
});

router.get('/test', getAuthValidator('account'), async (_req, res) => {
  res.json({
    status: 'Authorized',
  });
});

export default router;
