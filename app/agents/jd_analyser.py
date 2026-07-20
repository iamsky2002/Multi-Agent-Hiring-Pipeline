import json
import logging
import sys
from typing import Optional
from pydantic import BaseModel
from contextlib import AsyncExitStack

# Using the official mcp sdk client
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.agents.base import BaseAgent, with_retry
from app.schemas.jd import ExtractedJD

logger = logging.getLogger(__name__)

class JDAnalyserRequest(BaseModel):
    raw_text: str

class JDAnalyser(BaseAgent):
    """
    Agent responsible for extracting structured data from a raw job description.
    Uses the jd-parser-server MCP server to perform the actual parsing.
    """
    def __init__(self):
        super().__init__(name="JDAnalyser")
        # In a real deployed environment, this might point to a binary or an HTTP SSE endpoint.
        # Here we run the server script directly via stdio.
        self.server_params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "app.mcp_servers.jd_parser_server.server"],
            env=None # Inherit current environment which has OPENAI_API_KEY
        )

    @with_retry(max_retries=3, base_delay=2.0)
    async def _execute(self, request: JDAnalyserRequest) -> ExtractedJD:
        logger.info(f"{self.name} starting extraction...")
        
        async with AsyncExitStack() as stack:
            # Initialize the stdio client connection to the MCP server
            read, write = await stack.enter_async_context(stdio_client(self.server_params))
            session = await stack.enter_async_context(ClientSession(read, write))
            
            # Initialize connection
            await session.initialize()
            
            # Call the tool on the MCP server
            logger.info("Calling parse_raw_jd tool on MCP server...")
            result = await session.call_tool(
                name="parse_raw_jd",
                arguments={"raw_text": request.raw_text}
            )
            
            if result.isError:
                raise RuntimeError(f"MCP Tool Error: {result.content}")
                
            # The tool returns the JSON string in the first content block
            json_str = result.content[0].text
            
            # Parse the JSON string back into our Pydantic model to enforce the contract
            try:
                extracted_data = json.loads(json_str)
                validated_jd = ExtractedJD(**extracted_data)
                logger.info(f"{self.name} successfully extracted JD with confidence {validated_jd.confidence}")
                return validated_jd
            except json.JSONDecodeError:
                raise ValueError(f"Failed to decode JSON from MCP server: {json_str}")
            except Exception as e:
                raise ValueError(f"Failed to validate Pydantic schema from MCP output: {e}")
