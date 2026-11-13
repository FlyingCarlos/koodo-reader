import os
import sys

import uvicorn

from koodo_translation.api import app
from koodo_translation.cli import main as cli_main


if sys.argv[1] == "serve":
    os.environ["KOODO_DESKTOP_TRANSLATION_STATE"] = sys.argv[3]
    uvicorn.run(app, uds=sys.argv[2], access_log=False, timeout_graceful_shutdown=6)
else:
    del sys.argv[1]
    cli_main()
