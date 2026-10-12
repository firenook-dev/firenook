# Using the greeter

<p onclick="window.greeterNotes = 'clicked'">Thanks for installing the greeter.</p>
<script>window.greeterNotes = 'ran'</script>

Every visitor now reads: ${param:GREETING_TEMPLATE}

## Call it from your app

```js
const response = await fetch(`${functionsUrl}/ext-greeter-greet?name=Ada`)
const { greeting } = await response.json()
```

## Listen for greetings

Each greeting is published on Eventarc as `test.greeter.v1.greeted`, with the
subject `greetings/<name>`.

## See the profiles

The profiles it greets are in [Firestore](https://console.firebase.google.com/project/x/firestore/data).
Details are on [the greeter's page](https://example.com/greeter).
