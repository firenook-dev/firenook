// Runs the same FlutterFire calls against whichever emulator is on these ports
// and prints one deterministic line per check, so two backends can be compared
// on the same platform. See ../../README.md.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

const host = '127.0.0.1';
const email = 'ada@example.com';
const password = 'secret123';

Future<void> check(String name, Future<String> Function() body) async {
  try {
    final detail = await body().timeout(const Duration(seconds: 30));
    print('CHECK_RESULT ${jsonEncode({'name': name, 'ok': true, 'detail': detail})}');
  } catch (e) {
    final text = e is FirebaseException ? '${e.code}: ${e.message}' : e.toString();
    print('CHECK_RESULT ${jsonEncode({'name': name, 'ok': false, 'detail': text})}');
  }
}

void must(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<String> codeFrom(Future<Object?> Function() call) async {
  try {
    await call();
    return 'NO_ERROR';
  } on FirebaseException catch (e) {
    return e.code;
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MaterialApp(home: Scaffold(body: Center(child: Text('FlutterFire check')))));

  await Firebase.initializeApp(
    options: FirebaseOptions(
      // The iOS SDK crashes at startup unless the key is 39 characters starting with A.
      apiKey: 'Axxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      appId: kIsWeb
          ? '1:1234567890:web:abcdef012345'
          : defaultTargetPlatform == TargetPlatform.android
              ? '1:1234567890:android:abcdef012345'
              : '1:1234567890:ios:abcdef012345',
      messagingSenderId: '1234567890',
      projectId: 'demo-flutter',
      storageBucket: 'demo-flutter.appspot.com',
      authDomain: 'demo-flutter.firebaseapp.com',
      iosBundleId: 'dev.firenook.flutterCheck',
    ),
  );

  final auth = FirebaseAuth.instance;
  final db = FirebaseFirestore.instance;
  final storage = FirebaseStorage.instance;
  final fn = FirebaseFunctions.instance;

  await auth.useAuthEmulator(host, 19099);
  db.useFirestoreEmulator(host, 18080);
  await storage.useStorageEmulator(host, 19199);
  fn.useFunctionsEmulator(host, 15001);

  // A simulator keeps its cache and sign-in between runs.
  try {
    await auth.signOut();
    await db.clearPersistence();
  } catch (_) {}

  Future<void> signIn() => auth.signInWithEmailAndPassword(email: email, password: password);

  // ---------- Auth ----------
  await check('auth.signup', () async {
    final c = await auth.createUserWithEmailAndPassword(email: email, password: password);
    return 'email=${c.user!.email} verified=${c.user!.emailVerified} new=${c.additionalUserInfo?.isNewUser}';
  });
  await check('auth.id_token', () async {
    final t = await auth.currentUser!.getIdTokenResult();
    must((t.token ?? '').isNotEmpty, 'empty token');
    return 'provider=${t.signInProvider} email=${t.claims?['email']}';
  });
  await check('auth.profile', () async {
    await auth.currentUser!.updateDisplayName('Ada');
    await auth.currentUser!.reload();
    return 'name=${auth.currentUser!.displayName}';
  });
  await check('auth.signout_signin', () async {
    final before = auth.currentUser!.uid;
    await auth.signOut();
    must(auth.currentUser == null, 'still signed in');
    final c = await auth.signInWithEmailAndPassword(email: email, password: password);
    must(c.user!.uid == before, 'uid changed');
    return 'same uid';
  });
  await check('auth.wrong_password', () async {
    return codeFrom(() => auth.signInWithEmailAndPassword(email: email, password: 'wrong-password'));
  });
  await check('auth.unknown_user', () async {
    return codeFrom(() => auth.signInWithEmailAndPassword(email: 'nobody@example.com', password: password));
  });
  await check('auth.duplicate_signup', () async {
    return codeFrom(() => auth.createUserWithEmailAndPassword(email: email, password: password));
  });
  await check('auth.state_stream', () async {
    final next = auth.authStateChanges().where((u) => u == null).first;
    await auth.signOut();
    await next;
    await signIn();
    return 'signed-out event seen';
  });
  await check('auth.anonymous_delete', () async {
    await auth.signOut();
    final c = await auth.signInAnonymously();
    must(c.user!.isAnonymous, 'not anonymous');
    await c.user!.delete();
    must(auth.currentUser == null, 'still signed in after delete');
    await signIn();
    return 'anonymous created and deleted';
  });
  await check('auth.password_reset', () async {
    await auth.sendPasswordResetEmail(email: email);
    return 'sent';
  });

  // ---------- Firestore ----------
  final public = db.collection('public');

  await check('fs.value_types', () async {
    final at = Timestamp.fromMillisecondsSinceEpoch(1700000000000);
    await public.doc('types').set({
      's': 'text',
      'i': 42,
      'd': 1.5,
      'b': true,
      'nil': null,
      't': at,
      'g': const GeoPoint(3.1, 101.6),
      'bytes': Blob(Uint8List.fromList([1, 2, 3])),
      'list': [1, 'two', false],
      'map': {'nested': {'deep': 'yes'}},
      'ref': public.doc('other'),
    });
    final d = (await public.doc('types').get(const GetOptions(source: Source.server))).data()!;
    must(d['t'] == at, 'timestamp');
    must((d['g'] as GeoPoint).latitude == 3.1, 'geopoint');
    must((d['bytes'] as Blob).bytes.length == 3, 'bytes');
    must((d['ref'] as DocumentReference).path == 'public/other', 'reference');
    must((d['map'] as Map)['nested']['deep'] == 'yes', 'map');
    return 'keys=${(d.keys.toList()..sort()).join(",")} i=${d['i']} d=${d['d']}';
  });
  await check('fs.transforms', () async {
    final r = public.doc('transforms');
    await r.set({'n': 1, 'tags': ['a'], 'gone': 'x'});
    await r.update({
      'n': FieldValue.increment(2),
      'tags': FieldValue.arrayUnion(['b']),
      'at': FieldValue.serverTimestamp(),
      'gone': FieldValue.delete(),
    });
    final d = (await r.get(const GetOptions(source: Source.server))).data()!;
    must(d['at'] is Timestamp, 'serverTimestamp');
    return 'n=${d['n']} tags=${d['tags']} gone=${d.containsKey('gone')}';
  });
  await check('fs.set_merge', () async {
    final r = public.doc('merge');
    await r.set({'a': 1});
    await r.set({'b': 2}, SetOptions(merge: true));
    final d = (await r.get(const GetOptions(source: Source.server))).data()!;
    return 'a=${d['a']} b=${d['b']}';
  });

  for (var i = 0; i < 6; i++) {
    await public.doc('q$i').set({'kind': i.isEven ? 'even' : 'odd', 'rank': i, 'tags': ['t$i', 'all']});
  }
  String ids(QuerySnapshot<Map<String, dynamic>> s) => s.docs.map((d) => d.id).join(',');
  const server = GetOptions(source: Source.server);

  await check('fs.where_order_limit', () async {
    return ids(await public.where('kind', isEqualTo: 'even').orderBy('rank', descending: true).limit(2).get(server));
  });
  await check('fs.cursor', () async {
    return ids(await public.where('rank', isGreaterThanOrEqualTo: 0).orderBy('rank').startAfter([1]).limit(2).get(server));
  });
  await check('fs.where_in_array_contains', () async {
    final a = ids(await public.where('rank', whereIn: [1, 3]).orderBy('rank').get(server));
    final b = ids(await public.where('tags', arrayContains: 't2').get(server));
    return '$a|$b';
  });
  await check('fs.filter_or', () async {
    return ids(await public.where(Filter.or(Filter('rank', isEqualTo: 0), Filter('rank', isEqualTo: 5))).orderBy('rank').get(server));
  });
  await check('fs.aggregates', () async {
    final q = public.where('kind', isEqualTo: 'odd');
    final a = await q.aggregate(count(), sum('rank'), average('rank')).get();
    return 'count=${a.count} sum=${a.getSum('rank')} avg=${a.getAverage('rank')}';
  });
  await check('fs.transaction', () async {
    final r = public.doc('tx');
    await r.set({'n': 1});
    final out = await db.runTransaction((tx) async {
      final s = await tx.get(r);
      final n = (s.data()!['n'] as num).toInt();
      tx.update(r, {'n': n + 10});
      return n;
    });
    final d = (await r.get(server)).data()!;
    return 'read=$out now=${d['n']}';
  });
  await check('fs.batch', () async {
    final b = db.batch();
    b.set(public.doc('b1'), {'v': 1});
    b.set(public.doc('b2'), {'v': 2});
    b.delete(public.doc('merge'));
    await b.commit();
    final b2 = await public.doc('b2').get(server);
    final m = await public.doc('merge').get(server);
    return 'b2=${b2.data()!['v']} mergeExists=${m.exists}';
  });
  await check('fs.doc_listener', () async {
    final r = public.doc('watch');
    final seen = <String>[];
    final done = Completer<void>();
    final sub = r.snapshots().listen((s) {
      final v = s.exists ? '${s.data()!['v']}' : 'none';
      if (seen.isEmpty || seen.last != v) seen.add(v);
      if (v == 'none' && seen.length > 1 && !done.isCompleted) done.complete();
    });
    await Future<void>.delayed(const Duration(milliseconds: 500));
    await r.set({'v': 1});
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await r.update({'v': 2});
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await r.delete();
    await done.future.timeout(const Duration(seconds: 15));
    await sub.cancel();
    return seen.join('>');
  });
  await check('fs.query_listener', () async {
    final q = public.where('kind', isEqualTo: 'live');
    final types = <String>[];
    final done = Completer<void>();
    final sub = q.snapshots().listen((s) {
      for (final c in s.docChanges) {
        types.add(c.type.name);
        if (c.type == DocumentChangeType.removed && !done.isCompleted) done.complete();
      }
    });
    await Future<void>.delayed(const Duration(milliseconds: 500));
    await public.doc('live1').set({'kind': 'live', 'v': 1});
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await public.doc('live1').update({'v': 2});
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await public.doc('live1').update({'kind': 'gone'});
    await done.future.timeout(const Duration(seconds: 15));
    await sub.cancel();
    return types.join('>');
  });
  await check('fs.pending_writes', () async {
    final r = public.doc('pending');
    final states = <bool>[];
    final done = Completer<void>();
    final sub = r.snapshots(includeMetadataChanges: true).listen((s) {
      if (!s.exists) return;
      final p = s.metadata.hasPendingWrites;
      if (states.isEmpty || states.last != p) states.add(p);
      if (!p && !done.isCompleted) done.complete();
    });
    await r.set({'v': 1});
    await done.future.timeout(const Duration(seconds: 15));
    await sub.cancel();
    return states.join('>');
  });
  await check('fs.pending_writes_after_delay', () async {
    final r = public.doc('pending2');
    final states = <bool>[];
    final done = Completer<void>();
    final sub = r.snapshots(includeMetadataChanges: true).listen((s) {
      if (!s.exists) return;
      final p = s.metadata.hasPendingWrites;
      if (states.isEmpty || states.last != p) states.add(p);
      if (!p && !done.isCompleted) done.complete();
    });
    await Future<void>.delayed(const Duration(milliseconds: 1000));
    await r.set({'v': 1});
    await done.future.timeout(const Duration(seconds: 15));
    await sub.cancel();
    return states.join('>');
  });
  await check('fs.pending_writes_existing_doc', () async {
    final r = public.doc('pending3');
    await r.set({'v': 1});
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final states = <bool>[];
    var wrote = false;
    final done = Completer<void>();
    final sub = r.snapshots(includeMetadataChanges: true).listen((s) {
      final p = s.metadata.hasPendingWrites;
      if (states.isEmpty || states.last != p) states.add(p);
      if (wrote && !p && !done.isCompleted) done.complete();
    });
    await Future<void>.delayed(const Duration(milliseconds: 800));
    wrote = true;
    await r.update({'v': 2});
    await done.future.timeout(const Duration(seconds: 15));
    await sub.cancel();
    return states.join('>');
  });
  await check('fs.offline_then_sync', () async {
    final r = public.doc('offline');
    await db.disableNetwork();
    late final Future<void> write;
    try {
      write = r.set({'v': 'queued'});
      // A plugin call can overtake the set before it, so look until it arrives.
      Object? seen;
      for (var i = 0; i < 40 && seen == null; i++) {
        try {
          seen = (await r.get(const GetOptions(source: Source.cache))).data()?['v'];
        } on FirebaseException {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
      }
      must(seen == 'queued', 'not in cache');
    } finally {
      await db.enableNetwork();
    }
    await write;
    final s = await r.get(server);
    return 'server=${s.data()!['v']} fromCache=${s.metadata.isFromCache}';
  });
  await check('fs.collection_group', () async {
    await db.doc('groups/a/items/1').set({'v': 1});
    await db.doc('groups/b/items/2').set({'v': 2});
    final s = await db.collectionGroup('items').get(server);
    return (s.docs.map((d) => d.reference.path).toList()..sort()).join(',');
  });
  await check('fs.rules_signed_out', () async {
    await auth.signOut();
    final read = await codeFrom(() => db.doc('private/x').get(server));
    final write = await codeFrom(() => db.doc('owned/someone').set({'v': 1}));
    await signIn();
    return 'read=$read write=$write';
  });
  await check('fs.rules_signed_in', () async {
    final uid = auth.currentUser!.uid;
    final allowed = await codeFrom(() => db.doc('private/x').set({'v': 1}));
    final mine = await codeFrom(() => db.doc('owned/$uid').set({'v': 1}));
    final other = await codeFrom(() => db.doc('owned/not-me').set({'v': 1}));
    return 'private=$allowed mine=$mine other=$other';
  });
  await check('fs.listener_denied', () async {
    await auth.signOut();
    final completer = Completer<String>();
    final sub = db.collection('private').snapshots().listen(
      (_) {},
      onError: (Object e) {
        if (!completer.isCompleted) completer.complete(e is FirebaseException ? e.code : '$e');
      },
    );
    final code = await completer.future.timeout(const Duration(seconds: 15));
    await sub.cancel();
    await signIn();
    return code;
  });
  await check('fs.delete', () async {
    await public.doc('tx').delete();
    return 'exists=${(await public.doc('tx').get(server)).exists}';
  });

  // ---------- Storage ----------
  await check('st.put_get_metadata', () async {
    final r = storage.ref('open/hello.txt');
    await r.putString('hello', metadata: SettableMetadata(contentType: 'text/plain', customMetadata: {'k': 'v'}));
    final bytes = await r.getData();
    final m = await r.getMetadata();
    return 'text=${utf8.decode(bytes!)} type=${m.contentType} size=${m.size} custom=${m.customMetadata?['k']} name=${m.name} path=${m.fullPath}';
  });
  await check('st.binary_1mb', () async {
    final r = storage.ref('open/blob.bin');
    final data = Uint8List(1024 * 1024);
    for (var i = 0; i < data.length; i += 4096) {
      data[i] = i % 251;
    }
    final snap = await r.putData(data);
    final back = await r.getData(2 * 1024 * 1024);
    must(listEquals(back, data), 'bytes differ');
    return 'state=${snap.state.name} uploaded=${snap.bytesTransferred}';
  });
  await check('st.type_from_extension_only', () async {
    // Custom metadata and no content type: the Android SDK sends a body with no type.
    final r = storage.ref('open/untyped.bin');
    await r.putData(Uint8List.fromList([1, 2, 3]), SettableMetadata(customMetadata: {'k': 'v'}));
    final m = await r.getMetadata();
    return 'type=${m.contentType} size=${m.size} custom=${m.customMetadata?['k']}';
  });
  await check('st.resumable_300kb', () async {
    final r = storage.ref('open/resumable.bin');
    final data = Uint8List(300 * 1024);
    for (var i = 0; i < data.length; i++) {
      data[i] = (i * 31 + (i >> 8)) & 255;
    }
    final snap = await r.putData(data);
    final back = await r.getData(1024 * 1024);
    must(listEquals(back, data), 'bytes differ');
    return 'state=${snap.state.name} uploaded=${snap.bytesTransferred}';
  });
  await check('st.download_url', () async {
    final u = Uri.parse(await storage.ref('open/hello.txt').getDownloadURL());
    return 'port=${u.port} hasToken=${u.queryParameters.containsKey('token')} alt=${u.queryParameters['alt']}';
  });
  await check('st.list', () async {
    final l = await storage.ref('open').listAll();
    return (l.items.map((i) => i.name).toList()..sort()).join(',');
  });
  await check('st.list_recursive', () async {
    await storage.ref('deep/a.txt').putString('a');
    await storage.ref('deep/sub/b.txt').putString('b');
    final top = await storage.ref('deep').listAll();
    final sub = await storage.ref('deep/sub').listAll();
    return 'top=${top.items.map((i) => i.name).join(",")} folders=${top.prefixes.map((p) => p.name).join(",")} sub=${sub.items.map((i) => i.name).join(",")}';
  });
  await check('st.list_denied', () async {
    return codeFrom(() => storage.ref().listAll());
  });
  await check('st.update_metadata', () async {
    final r = storage.ref('open/hello.txt');
    final m = await r.updateMetadata(SettableMetadata(customMetadata: {'k': 'changed'}));
    return 'custom=${m.customMetadata?['k']}';
  });
  await check('st.rules', () async {
    final uid = auth.currentUser!.uid;
    final mine = await codeFrom(() async => storage.ref('users/$uid/a.txt').putString('x'));
    final other = await codeFrom(() async => storage.ref('users/not-me/a.txt').putString('x'));
    return 'mine=$mine other=$other';
  });
  await check('st.delete_then_missing', () async {
    final r = storage.ref('open/hello.txt');
    await r.delete();
    return codeFrom(() => r.getData());
  });

  // ---------- Functions ----------
  await check('fn.callable_with_auth', () async {
    final uid = auth.currentUser!.uid;
    final out = await fn.httpsCallable('echo').call<Map<String, dynamic>>({'a': 1, 'list': [1, 2]});
    must(out.data['uid'] == uid, 'uid not passed');
    return jsonEncode(out.data['echoed']);
  });
  await check('fn.callable_error', () async {
    try {
      await fn.httpsCallable('fails').call<dynamic>();
      return 'NO_ERROR';
    } on FirebaseFunctionsException catch (e) {
      return 'code=${e.code} message=${e.message} details=${jsonEncode(e.details)}';
    }
  });
  await check('fn.callable_signed_out', () async {
    await auth.signOut();
    final out = await fn.httpsCallable('echo').call<Map<String, dynamic>>({'a': 2});
    await signIn();
    return 'uid=${out.data['uid']}';
  });
  await check('fn.missing_function', () async {
    try {
      await fn.httpsCallable('doesNotExist').call<dynamic>();
      return 'NO_ERROR';
    } on FirebaseFunctionsException catch (e) {
      return 'code=${e.code}';
    }
  });

  print('CHECK_DONE');
}
