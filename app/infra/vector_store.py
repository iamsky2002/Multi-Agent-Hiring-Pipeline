import logging
import chromadb
from chromadb.utils import embedding_functions
from chromadb.config import Settings
from app.config import settings

logger = logging.getLogger(__name__)

class VectorStore:
    def __init__(self):
        # In a real setup with docker, we would connect to the HTTP client.
        # For simplicity in testing locally, we can use the HTTPClient if Chroma is running,
        # or fallback to PersistentClient if it's not (e.g. running outside docker without port mapping).
        # We will use HTTPClient assuming Chroma is running via docker-compose on localhost:8000
        try:
            self.client = chromadb.HttpClient(host='localhost', port=8000)
            logger.info("Connected to ChromaDB HTTP Client")
        except Exception as e:
            logger.warning(f"Could not connect to ChromaDB HTTP Client, falling back to local persistent client: {e}")
            self.client = chromadb.PersistentClient(path=settings.CHROMA_PERSIST_DIR)
            
        # Initialize default embedding function (all-MiniLM-L6-v2) to avoid OpenAI quota limits
        self.ef = embedding_functions.DefaultEmbeddingFunction()
        
        # Get or create the candidates collection
        self.collection_name = "candidates"
        self.collection = self.client.get_or_create_collection(
            name=self.collection_name,
            embedding_function=self.ef
        )
        
        # Get or create email templates collection
        self.template_collection_name = "email_templates"
        self.template_collection = self.client.get_or_create_collection(
            name=self.template_collection_name,
            embedding_function=self.ef
        )

    def upsert_candidate(self, candidate_id: str, document: str, metadata: dict = None):
        """Upserts a candidate's text representation into the vector store."""
        if metadata is None:
            metadata = {}
        
        self.collection.upsert(
            ids=[candidate_id],
            documents=[document],
            metadatas=[metadata]
        )
        logger.info(f"Upserted candidate {candidate_id} to vector store.")

    def search_candidates(self, query: str, top_k: int = 5) -> list[dict]:
        """Searches for semantically similar candidates based on the query."""
        candidate_count = self.collection.count()
        if candidate_count == 0:
            return []

        results = self.collection.query(
            query_texts=[query],
            n_results=min(top_k, candidate_count)
        )
        
        # Format the output to be easily consumable by the agent
        formatted_results = []
        if results and results['ids'] and results['ids'][0]:
            for i in range(len(results['ids'][0])):
                # Distance in chroma is usually L2, so smaller is better. 
                # We can invert it or use it as is.
                distance = results['distances'][0][i] if 'distances' in results and results['distances'] else 0.0
                
                # Simple normalization (this is naive, usually depends on distance metric)
                # Since OpenAI embeddings are normalized to length 1, L2 distance is related to cosine similarity:
                # cosine_similarity = 1 - (L2^2) / 2
                similarity = max(0.0, min(1.0, 1.0 - (distance / 2.0)))
                
                formatted_results.append({
                    "id": results['ids'][0][i],
                    "document": results['documents'][0][i],
                    "metadata": results['metadatas'][0][i],
                    "similarity_score": round(similarity, 4)
                })
        return formatted_results

    def get_candidate(self, candidate_id: str) -> dict | None:
        """Retrieves a candidate by ID."""
        results = self.collection.get(ids=[candidate_id])
        if results and results['ids']:
            return {
                "id": results['ids'][0],
                "document": results['documents'][0],
                "metadata": results['metadatas'][0]
            }
        return None

    def upsert_template(self, template_id: str, intent: str, template_text: str):
        self.template_collection.upsert(
            ids=[template_id],
            documents=[intent],
            metadatas=[{"template_text": template_text}]
        )
        
    def search_templates(self, intent_query: str, top_k: int = 2) -> list[str]:
        results = self.template_collection.query(
            query_texts=[intent_query],
            n_results=top_k
        )
        templates = []
        if results and results['ids'] and results['ids'][0]:
            for i in range(len(results['ids'][0])):
                meta = results['metadatas'][0][i]
                if meta and "template_text" in meta:
                    templates.append(meta["template_text"])
        return templates

# Singleton instance
vector_store = VectorStore()
