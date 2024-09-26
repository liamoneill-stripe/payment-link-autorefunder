require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
});
const bodyParser = require('body-parser');

const app = express();

const TARGET_PAYMENT_LINKS = [
    'plink_1Q3D5pGBuwvd4JCep27UzG5l',
    // Add more Payment Link IDs as needed
];

const VALID_PREFIX = 'sfx_';

// Helper function to create Stripe Dashboard URLs
function stripeDashboardUrl(objectType, objectId) {
    return `https://dashboard.stripe.com/${objectType}/${objectId}`;
}

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        console.log(`Full session object: ${stripeDashboardUrl('checkout/sessions', session.id)}`);
        console.log(JSON.stringify(session, null, 2));

        if (TARGET_PAYMENT_LINKS.includes(session.payment_link)) {
            let refundReason = '';

            if (!session.client_reference_id) {
                refundReason = 'No client_reference_id provided';
            } else if (!session.client_reference_id.startsWith(VALID_PREFIX)) {
                refundReason = `Invalid client_reference_id prefix. Expected: ${VALID_PREFIX}, Received: ${session.client_reference_id}`;
            }

            if (refundReason) {
                console.log(`Processing refund and cancellation for Payment Link ${stripeDashboardUrl('payment_links', session.payment_link)}. Reason: ${refundReason}`);

                if (session.mode === 'subscription' && session.subscription) {
                    try {
                        // Retrieve the subscription
                        const subscription = await stripe.subscriptions.retrieve(session.subscription);

                        // Cancel the subscription immediately
                        const cancelledSubscription = await stripe.subscriptions.cancel(session.subscription, {
                            invoice_now: true,
                            prorate: true
                        });

                        console.log(`Subscription cancelled: ${stripeDashboardUrl('subscriptions', cancelledSubscription.id)}`);

                        // Retrieve the latest invoice
                        const latestInvoice = await stripe.invoices.retrieve(subscription.latest_invoice);

                        // Refund the latest invoice
                        const refund = await stripe.refunds.create({
                            charge: latestInvoice.charge,
                        }, {
                            idempotencyKey: `refund_${session.id}`
                        });

                        console.log(`Refund issued: ${stripeDashboardUrl('refunds', refund.id)}`);
                        console.log(`Refund details: Amount: ${refund.amount / 100} ${refund.currency.toUpperCase()}, Charge: ${stripeDashboardUrl('charges', refund.charge)}`);
                    } catch (err) {
                        console.error(`Error processing subscription cancellation and refund: ${err.message}`);
                    }
                } else {
                    console.error('This is not a subscription or subscription ID is missing.');
                }
            } else {
                console.log(`Valid client_reference_id provided (${session.client_reference_id}). Subscription will continue: ${stripeDashboardUrl('subscriptions', session.subscription)}`);
            }
        } else {
            console.log(`Skipping check for session ${stripeDashboardUrl('checkout/sessions', session.id)}: Not a target Payment Link`);
        }
    }

    res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
