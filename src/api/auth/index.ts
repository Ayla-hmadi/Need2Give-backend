import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { NoResultError } from 'kysely';
import z from 'zod';
import { DatabaseError } from 'pg';

import config from '../../config';
import db from '../../db';
import {
  AccountSchema,
  accountSchema,
  donationCenterSchema,
  userSchema,
} from '../../schemas';
import { getAuthValidator, IDValidator } from '../middlewares';
import {
  generateJWT,
  saltRounds,
  getDuplicateProperty,
  toHtmlTable,
  transporter,
} from '../utils';
import { createValidator } from '../middlewares/requestValidator';

const router = Router();

const signupBodySchema = z.object({
  account: accountSchema.omit({ id: true, created_at: true }),
  profile: donationCenterSchema.omit({ id: true }).or(userSchema.omit({ id: true })),
});
const signupQuerySchema = z.object({
  role: z.enum(['donation_center', 'user']),
}).strict();
type SignupRequest =
  Request<{}, {}, z.infer<typeof signupBodySchema>, z.infer<typeof signupQuerySchema>>;

router.post(
  '/signup',
  createValidator({
    query: signupQuerySchema,
    body: signupBodySchema,
  }),
  async (req: SignupRequest, res: Response, next) => {
    try {
      await db.transaction().execute(async (trx) => {
        const { password, ...insertedAccount } = await trx
          .insertInto(
            req.query.role === 'donation_center'
              ? 'pending_account'
              : 'account',
          ).values({
            ...req.body.account,
            password: await bcrypt.hash(req.body.account.password, saltRounds),
          }).returningAll().executeTakeFirstOrThrow();

        const insertedProfile = await trx
          .insertInto(
            req.query.role === 'donation_center'
              ? 'pending_donation_center'
              : 'user',
          ).values({
            ...req.body.profile,
            id: insertedAccount.id,
          }).returningAll().executeTakeFirstOrThrow();

        if (req.query.role === 'donation_center') {
          const approveUrl = `http://${config.SERVER_HOST}:${config.SERVER_PORT}/auth/approve/${insertedAccount.id}`;
          const rejectUrl = `http://${config.SERVER_HOST}:${config.SERVER_PORT}/auth/reject/${insertedAccount.id}`;

          await transporter.sendMail({
            from: config.EMAIL_USER,
            to: config.EMAIL_ADMIN,
            subject: 'New donation center Sign-up',
            html: [
              `A new donation center with email ${insertedAccount.email} has requested to signed up.`,
              `<br>Click here to approve: ${approveUrl}`,
              `Click here to reject: ${rejectUrl}`,
              `<br>Donation center:\n${toHtmlTable({ ...insertedAccount, ...insertedProfile })}`,
            ].join('<br>'),
          });

          res.json({ status: 'Waiting for approval from admin' });
        } else {
          res.json({
            ...insertedAccount,
            ...insertedProfile,
            token: generateJWT(insertedAccount.id, 'user'),
          });
        }
      });
    } catch (error) {
      if (error instanceof DatabaseError) {
        const duplicateProperty = getDuplicateProperty(error);
        if (duplicateProperty !== null) {
          res.status(duplicateProperty === 'email' ? 400 : 409);
          next(new Error(`Duplicate ${duplicateProperty}`));
          return;
        }
      }
      next(error);
    }
  },
);

router.get('/approve/:id', IDValidator, async (req, res, next) => {
  try {
    const inserted = await db.transaction().execute(async (trx) => {
      const { id: filteredID, ...pendingDonationCenter } = await trx
        .deleteFrom('pending_donation_center')
        .where('id', '=', parseInt(req.params.id, 10))
        .returningAll()
        .executeTakeFirstOrThrow();

      const { id: previousID, ...pendingAccount } = await trx
        .deleteFrom('pending_account')
        .where('id', '=', parseInt(req.params.id, 10))
        .returningAll()
        .executeTakeFirstOrThrow();

      const insertedAccount = await trx.insertInto('account')
        .values(pendingAccount)
        .returningAll()
        .executeTakeFirstOrThrow();

      const insertedProfile = await trx.insertInto('donation_center')
        .values({
          ...pendingDonationCenter,
          id: insertedAccount.id,
        })
        .executeTakeFirstOrThrow();

      return {
        ...insertedAccount,
        ...insertedProfile,
      };
    });

    await transporter.sendMail({
      from: config.EMAIL_USER,
      to: inserted.email,
      subject: 'Need2Give Sign-up approved',
      html: 'Your donation center account has been approved by the system admins, you can now log in.',
    });

    res.json({ status: 'Donation Center approved successfully!' });
  } catch (error) {
    if (error instanceof NoResultError) {
      res.status(404);
    }
    if (error instanceof DatabaseError) {
      res.status(400);
    }
    next(error);
  }
});

router.get('/reject/:id', IDValidator, async (req, res, next) => {
  try {
    const { email } = await db.deleteFrom('pending_account')
      .where('id', '=', parseInt(req.params.id, 10))
      .returning('email')
      .executeTakeFirstOrThrow();

    await transporter.sendMail({
      from: config.EMAIL_USER,
      to: email,
      subject: 'Need2Give Sign-up rejected',
      html: 'Your donation center account has been rejected by the system admins',
    });

    res.json({ status: 'Donation Center rejected successfully!' });
  } catch (error) {
    if (error instanceof NoResultError) {
      res.status(404);
    }
    next(error);
  }
});

const loginValidator = createValidator({
  body: accountSchema.pick({ email: true, password: true }),
});

router.post('/login', loginValidator, async (req: Request<{}, {}, Pick<AccountSchema, 'email' | 'password'>>, res: Response, next) => {
  try {
    const { password, ...account } = await db.selectFrom('account').selectAll()
      .where('email', '=', req.body.email).executeTakeFirstOrThrow();

    if (!await bcrypt.compare(req.body.password, password)) {
      throw new EvalError();
    }

    const role = (await db.selectFrom('user')
      .where('user.id', '=', account.id)
      .executeTakeFirst()) === undefined ? 'donation_center' : 'user';

    res.json({
      account,
      token: generateJWT(account.id, role),
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
    profile: res.locals.profile,
    status: 'Authorized',
  });
});

router.patch('/', createValidator({
  body: accountSchema.pick({ email: true, password: true, phone_number: true }),
}), async (req, res, next) => {
  try {
    const { password, ...account } = await db.selectFrom('account')
      .selectAll()
      .where('email', '=', req.body.email)
      .executeTakeFirstOrThrow();

    if (!await bcrypt.compare(req.body.password, password)) {
      throw new EvalError();
    }

    const { password: filtered, ...updatedAccount } = await db.updateTable('account')
      .set({ phone_number: req.body.phone_number })
      .where('id', '=', account.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    res.json({
      account: updatedAccount,
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

router.delete(
  '/',
  loginValidator,
  async (req: Request<{}, {}, Pick<AccountSchema, 'email' | 'password'>>, res: Response, next) => {
    try {
      const { password, ...account } = await db.deleteFrom('account')
        .where('email', '=', req.body.email)
        .returningAll().executeTakeFirstOrThrow();
      res.json({ account });
    } catch (error) {
      if (error instanceof NoResultError) {
        res.status(404);
      }
      next(error);
    }
  },
);

export default router;
