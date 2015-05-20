/**
 * Waits for a DOM event on the specified node. Returns a promise
 * resolved with the event.
 */
function waitForDOMEvent(target, event, capture) {
	var deferred = Zotero.Promise.defer();
	var func = function(ev) {
		target.removeEventListener("event", func, capture);
		deferred.resolve(ev);
	}
	target.addEventListener(event, func, capture);
	return deferred.promise;
}

/**
 * Open a chrome window and return a promise for the window
 *
 * @return {Promise<ChromeWindow>}
 */
function loadWindow(winurl, argument) {
	var win = window.openDialog(winurl, "_blank", "chrome", argument);
	return waitForDOMEvent(win, "load").then(function() {
		return win;
	});
}

/**
 * Open a browser window and return a promise for the window
 *
 * @return {Promise<ChromeWindow>}
 */
function loadBrowserWindow() {
	var win = window.openDialog("chrome://browser/content/browser.xul", "", "all,height=400,width=1000");
	return waitForDOMEvent(win, "load").then(function() {
		return win;
	});
}

/**
 * Loads a Zotero pane in a new window and selects My Library. Returns the containing window.
 */
var loadZoteroPane = Zotero.Promise.coroutine(function* () {
	var win = yield loadBrowserWindow();
	win.ZoteroOverlay.toggleDisplay(true);
	
	// Hack to wait for pane load to finish. This is the same hack
	// we use in ZoteroPane.js, so either it's not good enough
	// there or it should be good enough here.
	yield Zotero.Promise.delay(52);
	
	yield waitForItemsLoad(win, 0);
	
	return win;
});

/**
 * Waits for a window with a specific URL to open. Returns a promise for the window.
 */
function waitForWindow(uri) {
	var deferred = Zotero.Promise.defer();
	Components.utils.import("resource://gre/modules/Services.jsm");
	var loadobserver = function(ev) {
		ev.originalTarget.removeEventListener("load", loadobserver, false);
		if(ev.target.location == uri) {
			Services.ww.unregisterNotification(winobserver);
			deferred.resolve(ev.target.docShell.QueryInterface(Components.interfaces.nsIInterfaceRequestor).
				             getInterface(Components.interfaces.nsIDOMWindow));
		}
	};
	var winobserver = {"observe":function(subject, topic, data) {
		if(topic != "domwindowopened") return;
		var win = subject.QueryInterface(Components.interfaces.nsIDOMWindow);
		win.addEventListener("load", loadobserver, false);
	}};
	Services.ww.registerNotification(winobserver);
	return deferred.promise;
}

var waitForItemsLoad = function (win, collectionRowToSelect) {
	var resolve;
	var promise = new Zotero.Promise(() => resolve = arguments[0]);
	var zp = win.ZoteroPane;
	var cv = zp.collectionsView;
	cv.addEventListener('load', function () {
		if (collectionRowToSelect !== undefined) {
			cv.selection.select(collectionRowToSelect);
		}
		zp.addEventListener('itemsLoaded', function () {
			resolve();
		});
	});
	return promise;
}

/**
 * Waits for a single item event. Returns a promise for the item ID(s).
 */
function waitForItemEvent(event) {
	var deferred = Zotero.Promise.defer();
	var notifierID = Zotero.Notifier.registerObserver({notify:function(ev, type, ids, extraData) {
		if(ev == event) {
			Zotero.Notifier.unregisterObserver(notifierID);
			deferred.resolve(ids);
		}
	}}, ["item"]);
	return deferred.promise;
}

/**
 * Looks for windows with a specific URL.
 */
function getWindows(uri) {
	Components.utils.import("resource://gre/modules/Services.jsm");
	var enumerator = Services.wm.getEnumerator(null);
	var wins = [];
	while(enumerator.hasMoreElements()) {
		var win = enumerator.getNext();
		if(win.location == uri) {
			wins.push(win);
		}
	}
	return wins;
}

/**
 * Resolve a promise when a specified callback returns true. interval
 * specifies the interval between checks. timeout specifies when we
 * should assume failure.
 */
function waitForCallback(cb, interval, timeout) {
	var deferred = Zotero.Promise.defer();
	if(interval === undefined) interval = 100;
	if(timeout === undefined) timeout = 10000;
	var start = Date.now();
	var id = setInterval(function() {
		var success = cb();
		if(success) {
			clearInterval(id);
			deferred.resolve(success);
		} else if(Date.now() - start > timeout*1000) {
			clearInterval(id);
			deferred.reject(new Error("Promise timed out"));
		}
	}, interval);
	return deferred.promise;
}

//
// Data objects
//
function createUnsavedDataObject(objectType, params) {
	params = params || {};
	if (objectType == 'item') {
		var param = 'book';
	}
	var obj = new Zotero[Zotero.Utilities.capitalize(objectType)](param);
	switch (objectType) {
	case 'collection':
	case 'search':
		obj.name = params.name !== undefined ? params.name : "Test";
		break;
	}
	if (params.version !== undefined) {
		obj.version = params.version
	}
	if (params.synced !== undefined) {
		obj.synced = params.synced
	}
	return obj;
}

var createDataObject = Zotero.Promise.coroutine(function* (objectType, params, saveOptions) {
	var obj = createUnsavedDataObject(objectType, params);
	var id = yield obj.saveTx(saveOptions);
	var objectsClass = Zotero.DataObjectUtilities.getObjectsClassForObjectType(objectType);
	return objectsClass.getAsync(id);
});

/**
 * Return a promise for the error thrown by a promise, or false if none
 */
function getPromiseError(promise) {
	return promise.thenReturn(false).catch(e => e);
}

/**
 * Ensures that the PDF tools are installed, or installs them if not.
 * Returns a promise.
 */
function installPDFTools() {
	if(Zotero.Fulltext.pdfConverterIsRegistered() && Zotero.Fulltext.pdfInfoIsRegistered()) {
		return Zotero.Promise.resolve(true);
	}

	// Begin install procedure
	return loadWindow("chrome://zotero/content/preferences/preferences.xul", {
		pane: 'zotero-prefpane-search',
		action: 'pdftools-install'
	}).then(function(win) {
		// Wait for confirmation dialog
		return waitForWindow("chrome://global/content/commonDialog.xul").then(function(dlg) {
			// Accept confirmation dialog
			dlg.document.documentElement.acceptDialog();

			// Wait for install to finish
			return waitForCallback(function() {
				return Zotero.Fulltext.pdfConverterIsRegistered() && Zotero.Fulltext.pdfInfoIsRegistered();
			}, 500, 30000).finally(function() {
				win.close();
			});
		});
	});
}

/**
 * Returns a promise for the nsIFile corresponding to the test data
 * directory (i.e., test/tests/data)
 */
function getTestDataDirectory() {
	Components.utils.import("resource://gre/modules/Services.jsm");
	var resource = Services.io.getProtocolHandler("resource").
	               QueryInterface(Components.interfaces.nsIResProtocolHandler),
	    resURI = Services.io.newURI("resource://zotero-unit-tests/data", null, null);
	return Services.io.newURI(resource.resolveURI(resURI), null, null).
	       QueryInterface(Components.interfaces.nsIFileURL).file;
}

/**
 * Resets the Zotero DB and restarts Zotero. Returns a promise resolved
 * when this finishes.
 */
function resetDB() {
	var db = Zotero.getZoteroDatabase();
	return Zotero.reinit(function() {
		db.remove(false);
	}).then(function() {
		return Zotero.Schema.schemaUpdatePromise;
	});
}