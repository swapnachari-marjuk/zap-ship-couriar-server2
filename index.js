const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const port = process.env.PORT || 3000;
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.2ic5wod.mongodb.net/?appName=Cluster0`;
const stripe = require("stripe")(process.env.STRIP_KEY);
const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-courier-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(cors());
app.use(express.json());
const verifyFBToken = async (req, res, next) => {
  const bearer = req.headers.authorization;
  if (!bearer) {
    return res.status(401).send({ message: "Unauthorized access!🤚" });
  }

  try {
    const tokenId = bearer.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(tokenId);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    console.log(error);
    return res.status(401).send({ message: "Unauthorized access!🤚" });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const usersColl = db.collection("users");
    const ridersColl = db.collection("riders");
    const parcelsColl = db.collection("parcels");
    const paymentColl = db.collection("payment");
    const trackingColl = db.collection("tracking");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersColl.findOne(query);
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access." });
      }
      next();
    };

    const logTracking = async (trackingID, status) => {
      const trackingLog = {
        trackingID,
        status,
        detail: status.split(/[_-]/).join(" "),
        createdAt: new Date(),
      };

      const result = await trackingColl.insertOne(trackingLog);
      return result;
    };

    // users related apis
    app.post("/users", async (req, res) => {
      const userDoc = req.body;
      userDoc.role = "user";
      userDoc.createdAt = new Date();
      const existingUser = await usersColl.findOne({ email: userDoc.email });
      if (existingUser) {
        return res.send({ message: "existing user logging in." });
      }
      const result = await usersColl.insertOne(userDoc);
      res.send(result);
    });

    // users getting api
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const { limit, skip, searchText } = req.query;
      const query = {};
      if (searchText) {
        query.displayName = { $regex: searchText, $options: "i" };
      }
      // console.log(limit, skip, searchText);
      const result = await usersColl
        .find(query)
        .limit(parseInt(limit))
        .skip(parseInt(skip))
        .toArray();
      const documentCount = await usersColl.countDocuments();
      // console.log(documentCount);
      res.send({ result, documentCount });
    });

    // admin approval api
    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { approvalStatus } = req.body;
        // console.log(approvalStatus);
        if (approvalStatus === "approved") {
          const update = { $set: { role: "admin" } };
          const result = await usersColl.updateOne(
            { _id: new ObjectId(id) },
            update
          );
          res.send({ result, approvalStatus: "approved" });
        }

        if (approvalStatus === "removed") {
          const update = { $set: { role: "user" } };
          const result = await usersColl.updateOne(
            { _id: new ObjectId(id) },
            update
          );
          res.send({ result, approvalStatus: "removed" });
        }
      }
    );

    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const { email } = req.params;
      const user = await usersColl.findOne({ email });
      res.send({ role: user.role || "user" });
    });

    // ridersColl
    app.post("/riders", verifyFBToken, async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();
      const result = await ridersColl.insertOne(rider);
      res.send(result);
    });

    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      const { status, workStatus, district: senderDistrict } = req.query;
      // console.log(req.query);
      const query = {};
      if (status) {
        query.status = status;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      if (senderDistrict) {
        query.riderDistrict = senderDistrict;
      }
      const result = await ridersColl
        .find(query)
        .sort({
          createdAt: -1,
        })
        .toArray();
      res.send(result);
    });

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;
      const query = { _id: new ObjectId(id) };
      const doc = {
        $set: { status: status, workStatus: "Available" },
      };

      if (status === "approved") {
        const update = { $set: { role: "rider" } };
        const userQuery = { email };
        const userApprove = await usersColl.updateOne(userQuery, update);
      }

      const result = await ridersColl.updateOne(query, doc);
      res.send(result);
    });

    // parcels related apis
    app.post("/parcels", verifyFBToken, async (req, res) => {
      const parcelsDoc = req.body;
      const trackingID = generateTrackingId();
      parcelsDoc.requestedAt = new Date();
      parcelsDoc.trackingID = trackingID;
      logTracking(trackingID, "Parcel_Request_Sent");
      const result = await parcelsColl.insertOne(parcelsDoc);
      res.send(result);
    });

    app.patch("/parcels", verifyFBToken, verifyAdmin, async (req, res) => {
      const { riderId, riderName, riderEmail, parcelId, trackingID } = req.body;
      const query = { _id: new ObjectId(parcelId) };
      const updateDoc = {
        $set: {
          deliveryStatus: "Assigned_Rider",
          riderId,
          riderName,
          riderEmail,
        },
      };

      const result = await parcelsColl.updateOne(query, updateDoc);

      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdateDoc = {
        $set: {
          workStatus: "In Delivery",
        },
      };
      const riderResult = await ridersColl.updateOne(
        riderQuery,
        riderUpdateDoc
      );

      logTracking(trackingID, "Assigned_Rider");

      res.send(riderResult);
    });

    app.get("/parcels", verifyFBToken, async (req, res) => {
      const parcels = req.body;
      const { email, deliveryStatus } = req.query;
      const query = {};
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { requestedAt: -1 };
      const result = await parcelsColl.find(query).sort(options).toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus !== "delivered") {
        // query.deliveryStatus = { $in: ["Assigned_Rider", "rider_arriving"] };
        query.deliveryStatus = { $nin: ["delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const result = await parcelsColl.find(query).toArray();
      res.send(result);
    });

    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsColl.findOne(query);
      res.send(result);
    });

    app.patch("/parcel/:id/status", async (req, res) => {
      const { deliveryStatus, riderEmail, trackingID } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const update = {
        $set: {
          deliveryStatus,
        },
      };

      if (deliveryStatus === "delivered") {
        const riderQuery = { riderEmail };
        const riderUpdate = { $set: { workStatus: "Available" } };
        const riderResult = await ridersColl.updateOne(riderQuery, riderUpdate);
        console.log(riderResult);
      }
      const result = await parcelsColl.updateOne(query, update);
      logTracking(trackingID, deliveryStatus);
      res.send(result);
    });

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsColl.deleteOne(query);
      res.send(result);
    });

    // payment apis
    app.post("/create-checkout-session", verifyFBToken, async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseFloat(paymentInfo?.courierCost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: { name: paymentInfo.parcelName },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelID,
          name: paymentInfo.parcelName,
          trackingID: paymentInfo.trackingID,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/paymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/paymentCancel`,
      });

      res.send(session.url);
    });

    app.patch("/payment-success", verifyFBToken, async (req, res) => {
      const sessionID = req.query.session_id;
      const sessionRetrieve = await stripe.checkout.sessions.retrieve(
        sessionID
      );

      const trackingID = sessionRetrieve.metadata.trackingID;
      const query = { transactionID: sessionRetrieve.payment_intent };
      const isExistingPayment = await paymentColl.findOne(query);
      if (isExistingPayment) {
        return res.send({
          message: "Already paid for it.",
          trackingID,
          transactionID: sessionRetrieve.payment_intent,
        });
      }

      if (sessionRetrieve.payment_status === "paid") {
        const id = sessionRetrieve.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
          },
        };
        const result = await parcelsColl.updateOne(query, update);

        const paymentHistory = {
          paymentAmount: sessionRetrieve.amount_total / 100,
          customerEmail: sessionRetrieve.customer_email,
          currency: sessionRetrieve.currency,
          parcelID: sessionRetrieve.metadata.parcelId,
          parcelName: sessionRetrieve.metadata.name,
          transactionID: sessionRetrieve.payment_intent,
          paymentStatus: sessionRetrieve.payment_status,
          paidAt: new Date(),
          trackingID: trackingID,
        };

        const resultPayment = await paymentColl.insertOne(paymentHistory);
        logTracking(trackingID, "pending-pickup");

        return res.send({
          success: true,
          trackingID,
          transactionID: sessionRetrieve.payment_intent,
          modifyParcel: result,
          paymentInfo: resultPayment,
        });
      }

      res.send({ success: false });
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      const sort = { paidAt: -1 };
      if (email) {
        query.customerEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }
      }
      const result = await paymentColl.find(query).sort(sort).toArray();
      res.send(result);
    });

    // parcels tracking apis
    app.get("/parcelTracing/:trackingID", async (req, res) => {
      const { trackingID } = req.params;
      console.log(trackingID);
      const query = { trackingID };
      const result = await trackingColl.find(query).toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap Shaft is Shifting...😉");
});

app.listen(port, () => {
  console.log(`Zap shift is listening on port ${port}`);
});

// errors are very annoying!
