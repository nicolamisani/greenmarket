# Greenmarket — student client

A prediction-market game for Bocconi 30296, Global Sustainability Strategy.
Students predict whether real green products are still on sale, and write what
value each product adds and destroys.

This folder is the public half. It holds no secret and no answer:

* the Firebase config is public by design; access is controlled by Firestore rules
* `INSTRUCTOR_PUBLIC_KEY` is the public half of a keypair. Member names and written
  answers are encrypted in the browser with it, and can only be read on the
  instructor's own machine
* the outcomes, the photographs and the scoring live on the instructor's machine and
  reach this page only after the market closes

Generated from the course repository. Do not edit `cases.js` or `style.css` by hand.
