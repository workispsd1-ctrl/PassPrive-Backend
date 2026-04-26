import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmStoreServiceBooking,
  StoreServiceBookingPayloadSchema,
} from "./storeServiceBookingService";
import {
  createConfirmStoreServiceBookingHandler,
  STORE_SERVICE_BOOKING_ROUTE_ALIASES,
} from "../routes/storeServiceBookings";

type DbMockOptions = {
  store?: any;
  existingBooking?: any;
};

function createDbMock(options: DbMockOptions = {}) {
  const writes: {
    insertedBooking?: any;
    updatedBooking?: any;
  } = {};

  const db = {
    writes,
    from(table: string) {
      const state: {
        filters: Record<string, any>;
        inFilters: Record<string, any[]>;
        pendingInsert?: any;
        pendingUpdate?: any;
      } = {
        filters: {},
        inFilters: {},
      };

      const chain: any = {
        select() {
          return chain;
        },
        eq(key: string, value: any) {
          state.filters[key] = value;
          return chain;
        },
        in(key: string, values: any[]) {
          state.inFilters[key] = values;
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        insert(payload: any) {
          state.pendingInsert = payload;
          writes.insertedBooking = payload;
          return chain;
        },
        update(payload: any) {
          state.pendingUpdate = payload;
          writes.updatedBooking = payload;
          return chain;
        },
        async maybeSingle() {
          if (table === "stores") {
            if (options.store && state.filters.id === options.store.id) {
              return { data: options.store, error: null };
            }
            return { data: null, error: null };
          }

          if (table === "store_orders") {
            const existing = options.existingBooking;
            const matchesStatus =
              !state.inFilters.status ||
              state.inFilters.status.includes(String(existing?.status ?? "").toUpperCase()) ||
              state.inFilters.status.includes(existing?.status);

            const matches =
              !!existing &&
              String(existing.store_id) === String(state.filters.store_id) &&
              String(existing.customer_user_id) === String(state.filters.customer_user_id) &&
              String(existing.slot_start_at) === String(state.filters.slot_start_at) &&
              matchesStatus;

            return { data: matches ? existing : null, error: null };
          }

          return { data: null, error: null };
        },
        async single() {
          if (table !== "store_orders") {
            return { data: null, error: new Error("Unsupported table single()") };
          }

          if (state.pendingInsert) {
            return {
              data: {
                id: "4dc176f2-88ee-4305-90de-ae4ab8de5bca",
                created_at: new Date().toISOString(),
                ...state.pendingInsert,
              },
              error: null,
            };
          }

          if (state.pendingUpdate) {
            return {
              data: {
                ...(options.existingBooking ?? {}),
                ...state.pendingUpdate,
                id: options.existingBooking?.id ?? "14aa8a6b-9003-441f-bd8f-b572f30cf341",
              },
              error: null,
            };
          }

          return { data: null, error: new Error("No insert/update payload found") };
        },
      };

      return chain;
    },
  };

  return db;
}

const customer = {
  userId: "7614baec-8fc3-4f2e-8f78-5fd94e74f8d2",
  fullName: "Test User",
  phone: "+2300000000",
  email: "test@example.com",
};

const storeId = "59588f50-3c85-4f2f-baf3-22739f907ac2";

test("valid service booking confirm persists booking payload", async () => {
  const db = createDbMock({
    store: { id: storeId, is_active: true },
  });

  const payload = {
    store: { id: storeId },
    serviceBooking: true,
    selectedDate: "2099-01-01",
    selectedTime: "10:30",
    notes: "Window seat if possible",
    services: [
      {
        id: "1e8f2ad4-6720-4f3e-9053-9e3a9ec4e4e6",
        title: "Hair Spa",
        quantity: 1,
        price: 250,
        duration_minutes: 45,
      },
    ],
    option: { type: "addon", label: "Premium" },
    payment: {
      amount: 250,
      status: "verified",
      method: "card",
      reference: "txn_123",
      verified: true,
    },
    metadata: {
      stylist: "Best available",
      source: "mobile_app",
    },
  };

  const parsed = StoreServiceBookingPayloadSchema.safeParse(payload);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const result = await confirmStoreServiceBooking(parsed.data, customer, db);
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  if (!result.ok) return;

  assert.equal(result.body.success, true);
  assert.equal(result.body.booking.store_id, storeId);
  assert.equal(result.body.booking.booking_date, "2099-01-01");
  assert.equal(result.body.booking.booking_time, "10:30:00");
  assert.equal(result.body.booking.status, "confirmed");
  assert.equal(result.body.booking.services.length, 1);

  assert.equal(db.writes.insertedBooking?.store_id, storeId);
  assert.equal(db.writes.insertedBooking?.customer_user_id, customer.userId);
  assert.equal(db.writes.insertedBooking?.payment_status, "PAID");
  assert.equal(db.writes.insertedBooking?.metadata?.stylist, "Best available");
  assert.equal(db.writes.insertedBooking?.service_type, "APPOINTMENT");
});

test("missing store id returns 400", async () => {
  const db = createDbMock({
    store: { id: storeId, is_active: true },
  });

  const result = await confirmStoreServiceBooking(
    {
      selectedDate: "2099-01-01",
      selectedTime: "10:30",
      services: [{ title: "Hair Spa", quantity: 1, price: 250, duration_minutes: 45 }],
    } as any,
    customer,
    db
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "STORE_ID_REQUIRED");
});

test("missing date or time returns 400", async () => {
  const db = createDbMock({
    store: { id: storeId, is_active: true },
  });

  const result = await confirmStoreServiceBooking(
    {
      store: { id: storeId },
      services: [{ title: "Hair Spa", quantity: 1, price: 250, duration_minutes: 45 }],
    } as any,
    customer,
    db
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "SLOT_REQUIRED");
});

test("no services returns 400", async () => {
  const db = createDbMock({
    store: { id: storeId, is_active: true },
  });

  const result = await confirmStoreServiceBooking(
    {
      store: { id: storeId },
      selectedDate: "2099-01-01",
      selectedTime: "10:30",
      services: [],
    } as any,
    customer,
    db
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "SERVICES_REQUIRED");
});

test("unauthorized request is handled by auth dependency", async () => {
  const handler = createConfirmStoreServiceBookingHandler({
    getCustomer: async (_req: any, res: any) => {
      res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
      return null;
    },
  });

  const resState: { statusCode?: number; payload?: any } = {};
  const res = {
    status(code: number) {
      resState.statusCode = code;
      return this;
    },
    json(payload: any) {
      resState.payload = payload;
      return this;
    },
  };

  await handler(
    {
      body: {
        store: { id: storeId },
        selectedDate: "2099-01-01",
        selectedTime: "10:30",
        services: [{ title: "Hair Spa", quantity: 1, price: 250, duration_minutes: 45 }],
      },
    },
    res
  );

  assert.equal(resState.statusCode, 401);
  assert.equal(resState.payload?.code, "UNAUTHORIZED");
});

test("alias route coverage includes all requested booking confirm paths", () => {
  assert.deepEqual([...STORE_SERVICE_BOOKING_ROUTE_ALIASES], [
    "/api/store-service-booking",
    "/api/store-service-bookings",
    "/api/service-bookings",
    "/api/store-bookings",
  ]);
});
