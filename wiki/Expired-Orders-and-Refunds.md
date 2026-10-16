# Expired Orders and Refunds

## What "expired" means

When a seller doesn't ship within the time AliExpress allows, AliExpress cancels the order. The order page and email say things like *"has not shipped in the required time"* or *"Order canceled due to late shipment"*.

Nothing is coming, a refund is on its way, and it's easy to miss. Cart Compass flags these orders so you can re-order anything you still need.

## Where you'll see them

- **In the popup**, under **⚠ Expired: never shipped**, with the refund status: *refunded $4.86 Oct 11*, or *refund expected by Oct 29*.
  - **Re-order** opens the product.
  - **View order** opens the order.
  - **Done** hides it once you've dealt with it.
- **On the product page**, the [[Re-order Warnings]] panel says *"Never shipped: your order … expired"*.

## How refunds are tracked

For cancelled and expired orders, Cart Compass looks for a completed refund in three places:
- the order card in **My Orders** (*Refund complete*);
- the order's detail page (*Refund successful*, or a refund amount);
- *"Cancellation refund processed"* emails, if you use the [[Gmail Backfill]].

**Fetch details** reads each closed order's page once, then re-checks every few days until the refund shows up.

If no refund is seen, Cart Compass assumes it has cleared once the **refund wait** has passed since the order closed: 14 days by default, changeable in [[Settings]]. This only affects when the order can be cleaned up. It doesn't mean the money has arrived, so check your payment method if it hasn't.

## Removing them from your list

Once the refund is complete, clean-up can remove cancelled and expired orders from your online AliExpress list. See [[Cleaning Up Your Order List]].
