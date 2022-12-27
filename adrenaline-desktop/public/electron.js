/***********
 * Constants
 ***********/

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const url = require("url");
const isDev = require("electron-is-dev");
const fs = require("fs");
const os = require("os");
const { Configuration, OpenAIApi } = require("openai");
const { exec, spawn } = require('node:child_process');
const defaultConfig = require('./config.js');
const Diff = require("diff");

/*********
 * Helpers
 *********/

const buildGPTPrompt = (brokenCode, stackTrace) =>
	`${defaultConfig.prompt}
	 ${defaultConfig.codeKey}
	 ${brokenCode}

	 ${defaultConfig.errorKey}
	 ${stackTrace}

	 ${defaultConfig.solutionKey}`;

const parseGPTOutput = (brokenCode, fixedCode) => {
	const diff = Diff.diffLines(brokenCode, fixedCode, ignoreWhitespace=false);
	console.log("diff: ", diff)
	let mergedCode = "";

	let hasOld = false;
	let isFixed = true;
	for (let i = 0; i < diff.length; i++) {
		let part = diff[i];
		let partLines = part.value.split('\n')
		if (!part.added && !part.removed) {
			mergedCode += part.value;
		} else if (part.removed) {
			mergedCode += '>>> OLD CODE <<<\n';
			hasOld = true;
			isFixed = false;
			for (let j = 0; j < partLines.length; j++) {
				mergedCode += partLines[j];
			}

			mergedCode += "\n================\n"
		} else if (part.added) {
			if (!hasOld) {
				mergedCode += '>>> OLD CODE <<<\n';
				hasOld = true;
				mergedCode += "================\n"
			}
			for (let j = 0; j < partLines.length; j++) {
				mergedCode += partLines[j];
			}

			mergedCode += '\n>>> FIXED CODE<<<\n'
			isFixed = true;
		} else {
		}
	}



	if (!isFixed) {
		mergedCode += '>>> FIXED CODE <<<'
	}
	const codeChanges = [];
	const lines = mergedCode.split('\n');
	let oldLines = [];
	let newLines = [];
	let mergeLine = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.includes('>>> OLD CODE')) {
			oldLines.push(i);
		} else if (line.includes('>>> FIXED CODE')) {
			newLines.push(i);
		} else if (line.includes('===============')) {
			mergeLine = i;
		}
		if (oldLines.length > 0 && newLines.length > 0 && mergeLine > -1) {

			for (let j = oldLines[0]+1; j < mergeLine; j++) {
				oldLines.push(j);
			}

			for (let k = mergeLine + 1; k < newLines[0]; k++) {
				newLines.push(k);
			}

			codeChanges.push({ oldLines, newLines, mergeLine });
			oldLines = [];
			newLines = [];
			mergeLine = -1;
		}
	}
	console.log("num changes: ", codeChanges.length)
	codeChanges.forEach( (codeChange) => {
		console.log("\tlines added: ", codeChange.newLines)
		console.log("\tlines removed: ", codeChange.oldLines)
		console.log("\tmed line: ", codeChange.mergeLine)
	});

	return {
		mergedCode,
		codeChanges
	};
}

const callGPTEditsAPI = (code, instruction, sendMessage) => {
	const apiConfig = new Configuration({apiKey: defaultConfig.apiKey});
	const api = new OpenAIApi(apiConfig);

	api
		.createEdit({
	    ...defaultConfig.editPromptParams, input: code, instruction
	  })
	  .then(data => {
			let changedCode = data.data.choices[0].text
			console.log("changedCode response: ", changedCode)
			const { mergedCode, codeChanges } = parseGPTOutput(code, changedCode);
			console.log("MERGED CODE ====================")
			console.log(mergedCode);
			sendMessage({ mergedCode, codeChanges });
			event.reply(ipcChannel, { mergedCode, codeChanges });
		})
		.catch((error) => console.log(error.response));
}

/**************
 * Window Setup
 **************/

let mainWindow;

function createWindow() {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		width: 800,
		height: 700,
		resizable: false,
		// titleBarStyle: "hidden",
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false
		}
	});

	mainWindow.loadURL(
		isDev
			? "http://localhost:3000"
			: `file://${path.join(__dirname, "../build/index.html")}`
	);
	mainWindow.on("closed", () => (mainWindow = null));
	// mainWindow.webContents.openDevTools(); // TEMP: For testing
}

app.whenReady().then(createWindow);
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

/******************************
 * Inter-Process Event Handlers
 ******************************/

ipcMain.on("runCommandRequest", (event, arg) => {
	const { command, currDir } = arg;

	if (command.trim() === "") {
		event.reply("runCommandResponse", { command, stdout: "", stderr: "" });
	} else {
		let commandToRun;
		let commandParts = command.split(" ");
		if (commandParts.length > 1) {
			const homeDir = os.homedir();
			const relativePath = `${currDir}/${commandParts[1]}`
			const absolutePath = path.resolve(homeDir, relativePath);

			commandToRun = `${commandParts[0]} ${absolutePath} ${commandParts.slice(2, commandParts.length)}`;
		} else {
			commandToRun = command;
		}

		exec(commandToRun, (err, stdout, stderr) => {
		  event.reply("runCommandResponse", {command, stdout, stderr});
		});
	}
});

ipcMain.on("fixErrorRequest", (event, arg) => {
	let mergedCodeLines = [
	  "def apply_func_to_input(func, input):",
	  "\tfunc(input)",
	  "",
	  "def main():",
	  "\tmy_data = []",
	  "\tfor i in range(10):",
		">>> OLD CODE",
	  "\t\tapply_func_to_input(my_data.add, i)",
		"============",
		"\t\tapply_func_to_input(my_data.append, i)",
		">>> FIXED CODE",
	  "",
	  "\tprint(my_data)",
	  "",
	  "main()"
	];
	let codeChanges = [{oldLines: [6, 7], mergeLine: 8, newLines: [9]}];
	event.reply("fixErrorResponse", { mergedCode: mergedCodeLines.join("\n"), codeChanges });

	// const { code, stackTrace } = arg;
	// const instruction = "Propose a fix for the code given this Error StackTrace: " + stackTrace.replace(/\n|\r/g, "");
	//
	// callGPTEditsAPI(code, instruction, payload => event.reply("fixErrorResponse", payload));
});
ipcMain.on("lintCodeRequest", (event, arg) => {
	const { code } = arg;
	const instruction = "Fix all the bugs in this code, if there are any.";

	callGPTEditsAPI(code, instruction, payload => event.reply("lintCodeResponse", payload));
});
ipcMain.on("optimizeCodeRequest", (event, arg) => {
	const { code } = arg;
	const instruction = "Optimize this code.";

	callGPTEditsAPI(code, instruction, payload => event.reply("optimizeCodeResponse", payload));
});
ipcMain.on("documentCodeRequest", (event, arg) => {
	const { code } = arg;
	const instruction = "Add comments to this code.";

	callGPTEditsAPI(code, instruction, payload => event.reply("documentCodeResponse", payload));
});

ipcMain.on("saveFileRequest", (event, arg) => {
	const { code, filePath } = arg;
	const homeDir = os.homedir();
	const fullPath = path.resolve(homeDir, filePath);

	fs.writeFile(fullPath, code.join("\n"), err => {
		if (err) {
			event.reply("saveFileResponse", { success: false });
		} else {
			event.reply("saveFileResponse", { success: true })
		}
 	});
});