const { getPool } = require('./db.js');

const PLANS = Object.freeze({
  basic: Object.freeze({
    code: 'basic',
    name: 'Basic',
    pricePkr: 1500,
    credits: 500,
    concurrency: 2,
    queuePriority: 10,
    badge: '',
    description: 'For individual creators getting started.',
    features: [
      '500 AI credits every purchase',
      'All standard video and image models',
      'Standard generation priority',
      'Up to 2 simultaneous generations',
    ],
  }),
  pro: Object.freeze({
    code: 'pro',
    name: 'Pro',
    pricePkr: 4500,
    credits: 1500,
    concurrency: 3,
    queuePriority: 20,
    badge: 'Most Popular',
    description: 'For creators and marketers producing content regularly.',
    features: [
      '1,500 AI credits every purchase',
      'All video and image models',
      'Priority generation queue',
      'Up to 3 simultaneous generations',
    ],
  }),
  premium: Object.freeze({
    code: 'premium',
    name: 'Premium',
    pricePkr: 12000,
    credits: 4000,
    concurrency: 5,
    queuePriority: 30,
    badge: 'Agency',
    description: 'For agencies and high-volume production teams.',
    features: [
      '4,000 AI credits every purchase',
      'All premium video and image models',
      'Highest generation priority',
      'Up to 5 simultaneous generations',
    ],
  }),
});

const UNPAID_PROFILE = Object.freeze({
  code: null,
  name: 'No paid plan',
  pricePkr: 0,
  credits: 0,
  concurrency: 1,
  queuePriority: 0,
  badge: '',
  description: '',
  features: [],
});

function getPlan(code) {
  const key = String(code || '').toLowerCase();
  return PLANS[key] || null;
}

function getPlanProfile(code) {
  return getPlan(code) || UNPAID_PROFILE;
}

function publicPlans() {
  return Object.values(PLANS).map(plan => ({
    code: plan.code,
    name: plan.name,
    pricePkr: plan.pricePkr,
    credits: plan.credits,
    concurrency: plan.concurrency,
    badge: plan.badge,
    description: plan.description,
    features: [...plan.features],
  }));
}

async function getPlanStatus(userId) {
  const db = getPool();
  const [[user]] = await db.execute('SELECT plan_code FROM users WHERE id=? LIMIT 1', [userId]);
  const [pendingRows] = await db.execute(
    `SELECT id, plan_code, price_pkr, credits, status, created_at
     FROM plan_requests
     WHERE user_id=? AND status='pending'
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const plan = getPlan(user?.plan_code);
  return {
    currentPlan: plan ? {
      code: plan.code,
      name: plan.name,
      concurrency: plan.concurrency,
      queuePriority: plan.queuePriority,
    } : null,
    pendingRequest: pendingRows[0] || null,
  };
}

async function createPlanRequest(userId, planCode) {
  const plan = getPlan(planCode);
  if (!plan) {
    const error = new Error('Choose a valid plan.');
    error.statusCode = 400;
    throw error;
  }

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [pending] = await conn.execute(
      "SELECT id FROM plan_requests WHERE user_id=? AND status='pending' LIMIT 1 FOR UPDATE",
      [userId],
    );
    if (pending[0]) {
      const error = new Error('You already have a pending plan request.');
      error.statusCode = 409;
      throw error;
    }

    const [result] = await conn.execute(
      `INSERT INTO plan_requests
       (user_id, plan_code, price_pkr, credits, concurrency_limit, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [userId, plan.code, plan.pricePkr, plan.credits, plan.concurrency],
    );

    await conn.commit();
    return {
      id: Number(result.insertId),
      planCode: plan.code,
      planName: plan.name,
      pricePkr: plan.pricePkr,
      credits: plan.credits,
      status: 'pending',
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function listPlanRequests(status = '') {
  const db = getPool();
  const allowed = ['pending','approved','rejected'];
  const normalized = allowed.includes(String(status)) ? String(status) : '';
  const params = [];
  const where = normalized ? ' WHERE pr.status=?' : '';
  if (normalized) params.push(normalized);
  const [rows] = await db.query(
    `SELECT pr.id, pr.user_id, u.email, u.plan_code AS current_plan,
            pr.plan_code, pr.price_pkr, pr.credits, pr.concurrency_limit,
            pr.status, pr.created_at, pr.decided_at
     FROM plan_requests pr
     JOIN users u ON u.id=pr.user_id` + where +
    ' ORDER BY pr.created_at DESC LIMIT 300',
    params,
  );
  return rows;
}

async function decidePlanRequest(requestId, action) {
  const normalizedAction = String(action || '');
  if (!['approve','reject'].includes(normalizedAction)) {
    const error = new Error('Invalid plan-request action.');
    error.statusCode = 400;
    throw error;
  }

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [requests] = await conn.execute(
      `SELECT * FROM plan_requests WHERE id=? FOR UPDATE`,
      [requestId],
    );
    const request = requests[0];
    if (!request) {
      const error = new Error('Plan request not found.');
      error.statusCode = 404;
      throw error;
    }
    if (request.status !== 'pending') {
      const error = new Error('This plan request has already been decided.');
      error.statusCode = 409;
      throw error;
    }

    if (normalizedAction === 'reject') {
      await conn.execute(
        "UPDATE plan_requests SET status='rejected', decided_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
        [requestId],
      );
      await conn.commit();
      return { id: Number(requestId), status: 'rejected' };
    }

    const plan = getPlan(request.plan_code);
    if (!plan) {
      const error = new Error('The requested plan is no longer valid.');
      error.statusCode = 409;
      throw error;
    }

    const [users] = await conn.execute(
      'SELECT id, email, credits FROM users WHERE id=? FOR UPDATE',
      [request.user_id],
    );
    const user = users[0];
    if (!user) {
      const error = new Error('User not found.');
      error.statusCode = 404;
      throw error;
    }

    const creditsToGrant = Number(request.credits);
    await conn.execute(
      'UPDATE users SET plan_code=?, credits=credits+?, updated_at=UTC_TIMESTAMP() WHERE id=?',
      [plan.code, creditsToGrant, user.id],
    );
    await conn.execute(
      `INSERT INTO credit_transactions (user_id, generation_id, amount, type, note)
       VALUES (?, NULL, ?, 'plan_credit', ?)`,
      [user.id, creditsToGrant, plan.name + ' plan credits'],
    );
    await conn.execute(
      "UPDATE plan_requests SET status='approved', decided_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [requestId],
    );

    await conn.commit();
    return {
      id: Number(requestId),
      status: 'approved',
      plan: plan.code,
      creditsGranted: creditsToGrant,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  PLANS,
  getPlan,
  getPlanProfile,
  publicPlans,
  getPlanStatus,
  createPlanRequest,
  listPlanRequests,
  decidePlanRequest,
};
